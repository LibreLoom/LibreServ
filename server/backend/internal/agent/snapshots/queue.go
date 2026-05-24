package snapshots

import (
	"context"
	"fmt"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

type Snapshot struct {
	ID             string
	ConversationID string
	AppID          string
	CreatedAt      time.Time
}

type Queue struct {
	mu        sync.Mutex
	backupSvc *storage.BackupService
	ch        chan snapshotRequest
	stopCh    chan struct{}
	running   bool
}

type snapshotRequest struct {
	convID string
	appID  string
	result chan snapshotResult
}

type snapshotResult struct {
	snapshot *Snapshot
	err      error
}

func NewQueue(backupSvc *storage.BackupService) *Queue {
	return &Queue{
		backupSvc: backupSvc,
		ch:        make(chan snapshotRequest, 64),
		stopCh:    make(chan struct{}),
	}
}

func (q *Queue) Start() {
	q.mu.Lock()
	if q.running {
		q.mu.Unlock()
		return
	}
	q.running = true
	q.mu.Unlock()
	go q.process()
}

func (q *Queue) Stop() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.running {
		return
	}
	q.running = false
	close(q.stopCh)
}

func (q *Queue) Submit(ctx context.Context, convID, appID string) (*Snapshot, error) {
	req := snapshotRequest{
		convID: convID,
		appID:  appID,
		result: make(chan snapshotResult, 1),
	}

	select {
	case q.ch <- req:
	default:
		return nil, fmt.Errorf("snapshot queue is full, try again later")
	case <-q.stopCh:
		return nil, fmt.Errorf("snapshot queue stopped")
	}

	select {
	case result := <-req.result:
		return result.snapshot, result.err
	case <-ctx.Done():
		return nil, fmt.Errorf("timeout waiting for snapshot: %w", ctx.Err())
	case <-time.After(30 * time.Second):
		return nil, fmt.Errorf("snapshot queue is busy, try again later")
	}
}

func (q *Queue) process() {
	for {
		select {
		case <-q.stopCh:
			return
		case req := <-q.ch:
			snapshot, err := q.createSnapshot(req)
			if err != nil {
				req.result <- snapshotResult{err: err}
			} else {
				req.result <- snapshotResult{snapshot: snapshot}
			}
		}
	}
}

func (q *Queue) createSnapshot(req snapshotRequest) (*Snapshot, error) {
	if q.backupSvc == nil {
		return nil, fmt.Errorf("backup service not available")
	}

	opts := storage.BackupOptions{}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	result, err := q.backupSvc.BackupApp(ctx, req.appID, opts)
	if err != nil {
		return nil, fmt.Errorf("backup failed: %w", err)
	}

	snapshotID := ""
	if result != nil && result.Backup != nil {
		snapshotID = result.Backup.ID
	}

	return &Snapshot{
		ID:             snapshotID,
		ConversationID: req.convID,
		AppID:          req.appID,
		CreatedAt:      time.Now(),
	}, nil
}

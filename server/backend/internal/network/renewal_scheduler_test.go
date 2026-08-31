package network

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

type mockRenewalQueue struct {
	running bool
	enqueue []string
	latest  map[string]jobqueue.JobInfo
	err     error
}

func (m *mockRenewalQueue) Enqueue(jobType jobqueue.JobType, domain, email, routeID string, priority jobqueue.JobPriority) (jobqueue.JobInfo, error) {
	m.enqueue = append(m.enqueue, domain)
	if m.err != nil {
		return nil, m.err
	}
	return &fakeJobInfo{id: "job-" + domain, status: string(jobqueue.JobStatusPending), domain: domain}, nil
}

func (m *mockRenewalQueue) GetLatestJob(ctx context.Context, domain string, jobType jobqueue.JobType) (jobqueue.JobInfo, error) {
	if m.latest != nil {
		if j, ok := m.latest[domain]; ok {
			return j, nil
		}
	}
	return nil, errors.New("not found")
}

func (m *mockRenewalQueue) IsRunning() bool { return m.running }

type fakeJobInfo struct {
	id, status, domain string
}

func (f *fakeJobInfo) GetID() string       { return f.id }
func (f *fakeJobInfo) GetStatus() string   { return f.status }
func (f *fakeJobInfo) GetDomain() string   { return f.domain }
func (f *fakeJobInfo) GetType() string     { return string(jobqueue.JobTypeRenewal) }
func (f *fakeJobInfo) GetPriority() int    { return 0 }
func (f *fakeJobInfo) GetRetryCount() int  { return 0 }
func (f *fakeJobInfo) GetMaxRetries() int  { return 3 }
func (f *fakeJobInfo) IsTerminal() bool {
	switch f.status {
	case string(jobqueue.JobStatusSucceeded), string(jobqueue.JobStatusFailed), string(jobqueue.JobStatusCancelled):
		return true
	default:
		return false
	}
}

func TestDefaultRenewalSchedulerConfigAndDisabled(t *testing.T) {
	cfg := DefaultRenewalSchedulerConfig()
	if !cfg.Enabled || cfg.Interval <= 0 || cfg.RenewalThreshold <= 0 {
		t.Fatalf("defaults = %+v", cfg)
	}
	rs := NewRenewalScheduler(nil, nil, RenewalSchedulerConfig{Enabled: false})
	rs.Start()
	rs.Stop()
}

func TestRenewalSchedulerStartStopAndNilDeps(t *testing.T) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	q := &mockRenewalQueue{running: true}
	rs := NewRenewalScheduler(q, nil, RenewalSchedulerConfig{
		Enabled:          true,
		Interval:         40 * time.Millisecond,
		RenewalThreshold: 24 * time.Hour,
	})
	rs.Start()
	time.Sleep(70 * time.Millisecond)
	rs.Stop()
}

func TestRenewalSchedulerSkipsWhenQueueStopped(t *testing.T) {
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, nil)))
	q := &mockRenewalQueue{running: false}
	rs := NewRenewalScheduler(q, nil, RenewalSchedulerConfig{Enabled: true, Interval: time.Hour})
	rs.checkAndRenew()
	q.running = true
	rs.checkAndRenew()
}

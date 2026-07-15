package apps

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type RepoStatus struct {
	URL        string    `json:"url"`
	Branch     string    `json:"branch"`
	Enabled    bool      `json:"enabled"`
	Priority   int       `json:"priority"`
	LastPull   time.Time `json:"last_pull"`
	LastCommit string    `json:"last_commit"`
	LastError  string    `json:"last_error,omitempty"`
}

type RepoSet struct {
	logger       *slog.Logger
	clients      []*RepoClient
	catalog      *Catalog
	basePath     string
	interval     time.Duration
	mu           sync.RWMutex
	stopCh       chan struct{}
	stopOnce     sync.Once
	started      bool
	onRevocation func(ctx context.Context) error
}

func NewRepoSet(logger *slog.Logger, configs []config.RepoConfig, basePath string, interval time.Duration) (*RepoSet, error) {
	if logger == nil {
		logger = slog.Default().With("component", "repo-set")
	}

	sorted := make([]config.RepoConfig, len(configs))
	copy(sorted, configs)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Priority < sorted[j].Priority
	})

	var clients []*RepoClient
	for i, cfg := range sorted {
		repoPath := filepath.Join(basePath, fmt.Sprintf("repo-%d", i))
		clients = append(clients, NewRepoClient(logger, cfg, repoPath))
	}

	return &RepoSet{
		logger:   logger,
		clients:  clients,
		catalog:  nil,
		basePath: basePath,
		interval: interval,
		stopCh:   make(chan struct{}),
	}, nil
}

func (rs *RepoSet) SetRevocationCallback(fn func(ctx context.Context) error) {
	rs.onRevocation = fn
}

func (rs *RepoSet) Start(ctx context.Context) error {
	rs.mu.Lock()
	if rs.started {
		rs.mu.Unlock()
		return nil
	}
	rs.started = true
	rs.mu.Unlock()

	go rs.runPeriodicPull(ctx)
	return nil
}

func (rs *RepoSet) Stop() {
	rs.stopOnce.Do(func() {
		close(rs.stopCh)
	})
}

func (rs *RepoSet) runPeriodicPull(ctx context.Context) {
	// Pull immediately on startup so the catalog is populated without delay.
	if err := rs.PullAll(ctx); err != nil {
		rs.logger.Warn("initial repo pull failed", "error", err)
	}

	// Skip the periodic loop if no interval is configured (e.g. in tests).
	if rs.interval <= 0 {
		return
	}

	ticker := time.NewTicker(rs.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-rs.stopCh:
			return
		case <-ticker.C:
			if err := rs.PullAll(ctx); err != nil {
				rs.logger.Warn("periodic repo pull failed", "error", err)
			}
		}
	}
}

func (rs *RepoSet) PullAll(ctx context.Context) error {
	type pullResult struct {
		client *RepoClient
		err    error
	}

	enabledCount := 0
	for _, c := range rs.clients {
		if c.config.Enabled {
			enabledCount++
		}
	}

	if enabledCount == 0 {
		return nil
	}

	resultCh := make(chan pullResult, enabledCount)

	for _, client := range rs.clients {
		if !client.config.Enabled {
			continue
		}
		go func(c *RepoClient) {
			resultCh <- pullResult{client: c, err: c.Pull(ctx)}
		}(client)
	}

	var errs []error
	for range enabledCount {
		res := <-resultCh
		if res.err != nil {
			errs = append(errs, res.err)
		}
	}

	rs.mu.Lock()
	rs.rebuildCatalog()
	rs.mu.Unlock()

	if rs.onRevocation != nil {
		if err := rs.onRevocation(ctx); err != nil {
			rs.logger.Warn("post-pull revocation check failed", "error", err)
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("repo pull errors: %v", errs)
	}

	return nil
}

func (rs *RepoSet) rebuildCatalog() {
	merged := make(map[string]*AppDefinition)

	for i := len(rs.clients) - 1; i >= 0; i-- {
		client := rs.clients[i]
		if !client.config.Enabled {
			continue
		}
		appsPath := client.AppsPath()
		if _, err := os.Stat(appsPath); os.IsNotExist(err) {
			continue
		}

		tmp := &Catalog{apps: make(map[string]*AppDefinition), catalogPath: client.localPath}
		if err := tmp.loadAppsFromDir(appsPath, AppTypeRepo); err != nil {
			rs.logger.Warn("failed to load repo apps", "path", appsPath, "error", err)
			continue
		}

		for id, app := range tmp.apps {
			app.SourceRepoURL = client.config.URL
			merged[id] = app
		}
	}

	if len(merged) == 0 {
		rs.catalog = nil
		rs.logger.Info("no repo apps loaded, catalog is empty")
		return
	}

	catalog := &Catalog{apps: merged, catalogPath: rs.basePath}
	rs.catalog = catalog
	rs.logger.Info("rebuilt merged catalog", "apps", len(merged))
}

func (rs *RepoSet) GetCatalog() *Catalog {
	rs.mu.RLock()
	defer rs.mu.RUnlock()
	return rs.catalog
}

func (rs *RepoSet) GetManifest(appID string) (*Manifest, error) {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	if rs.catalog == nil {
		return nil, fmt.Errorf("catalog not available")
	}

	app, err := rs.catalog.GetApp(appID)
	if err != nil {
		return nil, err
	}

	return LoadManifest(app.CatalogPath)
}

func (rs *RepoSet) RepoStatus() []RepoStatus {
	rs.mu.RLock()
	defer rs.mu.RUnlock()

	var statuses []RepoStatus
	for _, c := range rs.clients {
		status := RepoStatus{
			URL:        c.config.URL,
			Branch:     c.config.Branch,
			Enabled:    c.config.Enabled,
			Priority:   c.config.Priority,
			LastPull:   c.LastPull(),
			LastCommit: c.LastCommit(),
		}
		if err := c.LastError(); err != nil {
			status.LastError = err.Error()
		}
		statuses = append(statuses, status)
	}
	return statuses
}

package apps

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/transport/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type RepoClient struct {
	logger     *slog.Logger
	config     config.RepoConfig
	localPath  string
	mu         sync.RWMutex
	lastPullAt time.Time
	lastCommit string
	lastError  error
}

func NewRepoClient(logger *slog.Logger, cfg config.RepoConfig, localPath string) *RepoClient {
	return &RepoClient{
		logger:    logger,
		config:    cfg,
		localPath: localPath,
	}
}

func (r *RepoClient) Pull(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	branch := r.config.Branch
	if branch == "" {
		branch = "main"
	}

	var err error
	var repo *git.Repository

	if _, statErr := os.Stat(r.localPath); os.IsNotExist(statErr) {
		r.logger.Info("Cloning repository", "url", r.config.URL, "branch", branch, "path", r.localPath)
		repo, err = git.PlainCloneContext(ctx, r.localPath, false, &git.CloneOptions{
			URL:           r.config.URL,
			ReferenceName: plumbing.NewBranchReferenceName(branch),
			SingleBranch:  true,
			Depth:         1,
			Auth:          &http.BasicAuth{Username: "git", Password: ""},
		})
		if err != nil {
			r.lastError = err
			return fmt.Errorf("failed to clone repo: %w", err)
		}
	} else {
		r.logger.Info("Pulling repository", "url", r.config.URL, "path", r.localPath)
		repo, err = git.PlainOpen(r.localPath)
		if err != nil {
			return fmt.Errorf("failed to open repo at %s: %w", r.localPath, err)
		}
		worktree, err := repo.Worktree()
		if err != nil {
			return fmt.Errorf("failed to get worktree: %w", err)
		}
		err = worktree.PullContext(ctx, &git.PullOptions{
			ReferenceName: plumbing.NewBranchReferenceName(branch),
			SingleBranch:  true,
			Depth:         1,
			Auth:          &http.BasicAuth{Username: "git", Password: ""},
		})
		if err != nil && err != git.NoErrAlreadyUpToDate {
			r.lastError = err
			return fmt.Errorf("failed to pull repo: %w", err)
		}
	}

	r.lastError = nil
	r.lastPullAt = time.Now()

	if repo != nil {
		head, headErr := repo.Head()
		if headErr == nil {
			r.lastCommit = head.Hash().String()
		}
	}

	return nil
}

func (r *RepoClient) LastPull() time.Time {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastPullAt
}

func (r *RepoClient) LastCommit() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastCommit
}

func (r *RepoClient) LastError() error {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.lastError
}

func (r *RepoClient) LocalPath() string {
	return r.localPath
}

func (r *RepoClient) AppsPath() string {
	return filepath.Join(r.localPath, "apps")
}

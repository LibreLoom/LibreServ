package storage

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
)

func (s *BackupService) GetRepository(ctx context.Context, repoID string) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
	SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
	FROM backup_repositories WHERE id = ?
	`, repoID).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("backup repository not found: %w", err)
	}
	return &repo, nil
}

func (s *BackupService) ListRepositories(ctx context.Context) ([]BackupRepository, error) {
	rows, err := s.db.Query(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, fmt.Errorf("failed to query backup repositories: %w", err)
	}
	defer rows.Close()

	var repos []BackupRepository
	for rows.Next() {
		var repo BackupRepository
		if err := rows.Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt); err != nil {
			log.Printf("failed to scan backup repository row: %v", err)
			continue
		}
		repos = append(repos, repo)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate backup repositories: %w", err)
	}
	return repos, nil
}

func (s *BackupService) GetRepositoryForApp(ctx context.Context, appID string) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories WHERE app_id = ? LIMIT 1
	`, appID).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("no repository configured for app %s: %w", appID, err)
	}
	return &repo, nil
}

// GetDefaultRepository returns the first non-system repo with no app assignment,
// which serves as the fallback for apps without an explicit repo.
func (s *BackupService) GetDefaultRepository(ctx context.Context) (*BackupRepository, error) {
	var repo BackupRepository
	err := s.db.QueryRow(`
		SELECT id, COALESCE(app_id, ''), repo_type, repo_path, password, credentials, COALESCE(is_system, 0), COALESCE(limit_upload_kbps, 0), COALESCE(limit_download_kbps, 0), created_at, updated_at
		FROM backup_repositories WHERE app_id IS NULL AND COALESCE(is_system, 0) = 0
		ORDER BY created_at DESC LIMIT 1
	`).Scan(&repo.ID, &repo.AppID, &repo.RepoType, &repo.RepoPath, &repo.Password, &repo.Credentials, &repo.IsSystem, &repo.LimitUploadKbps, &repo.LimitDownloadKbps, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		return nil, fmt.Errorf("no default repository configured: %w", err)
	}
	return &repo, nil
}

func (s *BackupService) DeleteRepository(ctx context.Context, repoID string) error {
	_, err := s.db.Exec("DELETE FROM backup_repositories WHERE id = ?", repoID)
	if err != nil {
		return fmt.Errorf("failed to delete backup repository: %w", err)
	}
	log.Printf("Backup repository deleted: %s", repoID)
	return nil
}

func (s *BackupService) TestRepository(ctx context.Context, repoConfig restic.RepoConfig) error {
	if s.resticEngine == nil {
		return fmt.Errorf("restic engine not available")
	}
	return s.resticEngine.Check(ctx, repoConfig)
}

func (s *BackupService) GetRepoStats(ctx context.Context, repoID string) (map[string]interface{}, error) {
	if s.resticEngine == nil {
		return nil, fmt.Errorf("restic engine not available")
	}
	repo, err := s.GetRepository(ctx, repoID)
	if err != nil {
		return nil, fmt.Errorf("repository not found: %w", err)
	}
	repoConfig := s.buildRepoConfigFromRepository(repo)
	return s.resticEngine.Stats(ctx, *repoConfig)
}

// GetRepositoryRecoveryKey decrypts and returns the recovery key (password)
// for a given backup repository. This is the key needed to restore backups
// from this repository on a new server.
func (s *BackupService) GetRepositoryRecoveryKey(ctx context.Context, repoID string) (string, error) {
	repo, err := s.GetRepository(ctx, repoID)
	if err != nil {
		return "", fmt.Errorf("repository not found: %w", err)
	}

	password := repo.Password
	if s.encryptionKey != "" && password != "" {
		decPass, decErr := decryptAESGCM(password, s.encryptionKey)
		if decErr != nil {
			return "", fmt.Errorf("could not decrypt recovery key: %w", decErr)
		}
		password = decPass
	}

	return password, nil
}

// --- Internal helpers ---
func (s *BackupService) getOrCreateRepoForApp(ctx context.Context, appID string) (*restic.RepoConfig, string, error) {
	existing, err := s.GetRepositoryForApp(ctx, appID)
	if err == nil && existing != nil {
		return s.buildRepoConfigFromRepository(existing), existing.ID, nil
	}

	defaultRepo, defErr := s.GetDefaultRepository(ctx)
	if defErr == nil && defaultRepo != nil {
		return s.buildRepoConfigFromRepository(defaultRepo), defaultRepo.ID, nil
	}

	repoID := uuid.New().String()
	repoType := "local"
	repoPath := restic.BuildRepoPath(repoType, s.basePath, appID)
	password := restic.DeriveRepoPassword(s.serverSecret, appID)

	repo := &BackupRepository{
		ID:        repoID,
		AppID:     appID,
		RepoType:  repoType,
		RepoPath:  repoPath,
		Password:  password,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.CreateRepository(ctx, repo); err != nil {
		return nil, "", err
	}

	return s.buildRepoConfigFromRepository(repo), repoID, nil
}

func (s *BackupService) getRepoForApp(ctx context.Context, appID string) (*restic.RepoConfig, string, error) {
	repo, err := s.GetRepositoryForApp(ctx, appID)
	if err != nil {
		return nil, "", err
	}
	return s.buildRepoConfigFromRepository(repo), repo.ID, nil
}

func (s *BackupService) getRepoByBackup(ctx context.Context, backup *Backup) (*restic.RepoConfig, error) {
	if backup.RepoID != "" {
		repo, err := s.GetRepository(ctx, backup.RepoID)
		if err != nil {
			return nil, fmt.Errorf("repository %s not found: %w", backup.RepoID, err)
		}
		return s.buildRepoConfigFromRepository(repo), nil
	}

	if backup.AppID != "" {
		repo, err := s.GetRepositoryForApp(ctx, backup.AppID)
		if err != nil {
			defaultRepo, defErr := s.GetDefaultRepository(ctx)
			if defErr != nil {
				return nil, fmt.Errorf("no repository for app %s and no default: %w", backup.AppID, defErr)
			}
			return s.buildRepoConfigFromRepository(defaultRepo), nil
		}
		return s.buildRepoConfigFromRepository(repo), nil
	}

	return nil, fmt.Errorf("cannot determine restic repository for backup %s", backup.ID)
}

func (s *BackupService) buildRepoConfigFromRepository(repo *BackupRepository) *restic.RepoConfig {
	env := map[string]string{}
	rawCreds := repo.Credentials

	if s.encryptionKey != "" && rawCreds != "" {
		if decCreds, err := decryptAESGCM(rawCreds, s.encryptionKey); err == nil {
			rawCreds = decCreds
		} else {
			log.Printf("Warning: failed to decrypt repo credentials for %s: %v", repo.ID, err)
		}
	}

	if rawCreds != "" {
		var creds map[string]string
		if json.Unmarshal([]byte(rawCreds), &creds) == nil {
			env = creds
		}
	}

	password := repo.Password
	if s.encryptionKey != "" && password != "" {
		if decPass, err := decryptAESGCM(password, s.encryptionKey); err == nil {
			password = decPass
		} else {
			log.Printf("Warning: failed to decrypt repo password for %s: %v", repo.ID, err)
		}
	}

	return &restic.RepoConfig{
		Type:              repo.RepoType,
		Path:              repo.RepoPath,
		Password:          password,
		Env:               env,
		LimitUploadKbps:   repo.LimitUploadKbps,
		LimitDownloadKbps: repo.LimitDownloadKbps,
	}
}

func (s *BackupService) runPreBackupHook(ctx context.Context, appID, appPath string) error {
	hookPath := filepath.Join(appPath, "scripts", "system-backup")
	if _, err := os.Stat(hookPath); err != nil {
		return nil
	}

	log.Printf("Running pre-backup hook for app %s", appID)
	cmd := exec.CommandContext(ctx, hookPath)
	cmd.Dir = appPath
	cmd.Env = append(os.Environ(),
		"LIBRESERV_APP_ID="+appID,
		"LIBRESERV_APP_PATH="+appPath,
		"LIBRESERV_BACKUP_HOOK=true",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("backup hook failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

// removeTemp deletes an intermediate file. Failing to clean it up is not worth
// failing the caller over, but a leaked file eats disk until someone notices.
func removeTemp(path string) {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		log.Printf("Warning: failed to remove temporary file %s: %v", path, err)
	}
}

func compressFile(srcPath, destPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()

	dest, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer func() { _ = dest.Close() }()

	gzWriter := gzip.NewWriter(dest)
	defer gzWriter.Close()

	_, err = io.Copy(gzWriter, src)
	return err
}

func fileChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

var safePathRegexp = regexp.MustCompile(`^[a-zA-Z0-9._/\-]+$`)

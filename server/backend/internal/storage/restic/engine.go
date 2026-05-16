package restic

import (
	"bufio"
	"compress/bzip2"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	osdist "gt.plainskill.net/LibreLoom/LibreServ/OS"
)

const DefaultResticVersion = "0.18.1"

var ExpectedResticHashes = map[string]string{
	"linux/amd64":  "680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d",
	"linux/arm64":  "87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45",
	"darwin/amd64": "eb8543ed92ff1ddb67762daebf09f7bea4b0c37d21edb6a910bee3d4f514015f",
	"darwin/arm64": "193fccc8bb4567b498923bc70261e104ff22be88016f0f108b035dad372ab711",
}

var binaryMu sync.Mutex
var cachedBinaryPath string

func FindBinary() (string, error) {
	binaryMu.Lock()
	defer binaryMu.Unlock()

	if cachedBinaryPath != "" {
		if _, err := os.Stat(cachedBinaryPath); err == nil {
			return cachedBinaryPath, nil
		}
		cachedBinaryPath = ""
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		homeDir = "/root"
	}
	candidatePaths := []string{
		filepath.Join(homeDir, ".libreserv", "bin", "restic"),
		"/usr/local/bin/restic",
		"/usr/bin/restic",
	}

	for _, p := range candidatePaths {
		if _, err := os.Stat(p); err == nil {
			cachedBinaryPath = p
			return p, nil
		}
	}

	if p, err := exec.LookPath("restic"); err == nil {
		abs, _ := filepath.Abs(p)
		if abs != "" {
			cachedBinaryPath = abs
			return abs, nil
		}
		cachedBinaryPath = p
		return p, nil
	}

	if extracted := extractEmbeddedBinary(homeDir); extracted != "" {
		cachedBinaryPath = extracted
		return extracted, nil
	}

	return "", fmt.Errorf("restic binary not found; install restic, place it at %s, or enable auto-provision", candidatePaths[0])
}

func extractEmbeddedBinary(homeDir string) string {
	if len(osdist.ResticBinary) == 0 {
		return ""
	}

	targetDir := filepath.Join(homeDir, ".libreserv", "bin")
	targetPath := filepath.Join(targetDir, "restic")

	if _, err := os.Stat(targetPath); err == nil {
		return targetPath
	}

	if err := os.MkdirAll(targetDir, 0750); err != nil {
		slog.Error("failed to create restic bin dir", "path", targetDir, "error", err)
		return ""
	}

	tmpFile, err := os.CreateTemp(targetDir, "restic-*.tmp")
	if err != nil {
		slog.Error("failed to create temp file for restic extraction", "error", err)
		return ""
	}
	tmpPath := tmpFile.Name()

	if _, err := tmpFile.Write(osdist.ResticBinary); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		slog.Error("failed to write embedded restic binary", "error", err)
		return ""
	}
	tmpFile.Close()

	if err := os.Chmod(tmpPath, 0750); err != nil {
		os.Remove(tmpPath)
		slog.Error("failed to chmod embedded restic binary", "error", err)
		return ""
	}

	if err := os.Rename(tmpPath, targetPath); err != nil {
		os.Remove(tmpPath)
		slog.Error("failed to rename embedded restic binary", "error", err)
		return ""
	}

	slog.Info("extracted embedded restic binary", "path", targetPath)
	return targetPath
}

// AutoProvision downloads the restic binary to ~/.libreserv/bin/restic if not found.
func AutoProvision() (string, error) {
	if _, err := FindBinary(); err == nil {
		return "", nil
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home dir: %w", err)
	}

	targetDir := filepath.Join(homeDir, ".libreserv", "bin")
	targetPath := filepath.Join(targetDir, "restic")

	if err := os.MkdirAll(targetDir, 0750); err != nil {
		return "", fmt.Errorf("create bin dir: %w", err)
	}

	goos := runtime.GOOS
	goarch := runtime.GOARCH
	url := fmt.Sprintf("https://github.com/restic/restic/releases/download/v%s/restic_%s_%s_%s.bz2",
		DefaultResticVersion, DefaultResticVersion, goos, goarch)

	slog.Info("auto-provisioning restic binary", "url", url, "version", DefaultResticVersion)

	resp, err := http.Get(url)
	if err != nil {
		return "", fmt.Errorf("download restic: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download restic: HTTP %d", resp.StatusCode)
	}

	tmpFile, err := os.CreateTemp(targetDir, "restic-download-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()

	hasher := sha256.New()
	writer := io.MultiWriter(tmpFile, hasher)

	if _, err := io.Copy(writer, resp.Body); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("download restic: write error: %w", err)
	}
	tmpFile.Close()

	actualHash := fmt.Sprintf("%x", hasher.Sum(nil))

	pinnedHash, hasPinned := ExpectedResticHashes[goos+"/"+goarch]
	if hasPinned && pinnedHash != "" {
		if actualHash != pinnedHash {
			os.Remove(tmpPath)
			return "", fmt.Errorf("restic checksum mismatch: pinned %s, got %s", pinnedHash, actualHash)
		}
		slog.Info("restic download verified against pinned hash")
	} else {
		if err := verifyChecksumFromRemote(DefaultResticVersion, goos, goarch, actualHash, tmpPath); err != nil {
			return "", err
		}
	}

	if err := decompressBz2(tmpPath); err != nil {
		return "", err
	}

	extractedPath := strings.TrimSuffix(tmpPath, ".bz2")
	if err := os.Chmod(extractedPath, 0750); err != nil {
		os.Remove(extractedPath)
		return "", fmt.Errorf("chmod restic: %w", err)
	}

	if err := os.Rename(extractedPath, targetPath); err != nil {
		os.Remove(extractedPath)
		return "", fmt.Errorf("rename restic: %w", err)
	}

	slog.Info("restic auto-provisioned successfully", "path", targetPath)

	binaryMu.Lock()
	cachedBinaryPath = targetPath
	binaryMu.Unlock()

	return targetPath, nil
}

func verifyChecksumFromRemote(version, goos, goarch, actualHash, tmpPath string) error {
	checksumURL := fmt.Sprintf("https://github.com/restic/restic/releases/download/v%s/SHA256SUMS", version)
	checksumResp, err := http.Get(checksumURL)
	if err != nil {
		return fmt.Errorf("could not fetch SHA256SUMS for verification: %w", err)
	}
	defer checksumResp.Body.Close()

	if checksumResp.StatusCode != http.StatusOK {
		return fmt.Errorf("SHA256SUMS fetch returned HTTP %d, cannot verify restic binary integrity", checksumResp.StatusCode)
	}

	expectedFile := fmt.Sprintf("restic_%s_%s_%s.bz2", version, goos, goarch)
	scanner := bufio.NewScanner(checksumResp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasSuffix(line, expectedFile) {
			parts := strings.Fields(line)
			if len(parts) >= 1 {
				expectedHash := parts[0]
				if actualHash != expectedHash {
					os.Remove(tmpPath)
					return fmt.Errorf("restic checksum mismatch: expected %s, got %s", expectedHash, actualHash)
				}
				slog.Info("restic download checksum verified against remote SHA256SUMS")
			}
			return nil
		}
	}

	return fmt.Errorf("restic %s/%s/%s not found in SHA256SUMS — cannot verify binary integrity", version, goos, goarch)
}

func decompressBz2(bz2Path string) error {
	in, err := os.Open(bz2Path)
	if err != nil {
		return fmt.Errorf("open bzip2 file: %w", err)
	}
	defer in.Close()

	outPath := strings.TrimSuffix(bz2Path, ".bz2")
	out, err := os.Create(outPath)
	if err != nil {
		return fmt.Errorf("create output file: %w", err)
	}
	defer out.Close()

	bz2Reader := bzip2.NewReader(in)
	if _, err := io.Copy(out, bz2Reader); err != nil {
		os.Remove(outPath)
		return fmt.Errorf("decompress restic: %w", err)
	}

	os.Remove(bz2Path)
	return nil
}

func IsAvailable() bool {
	_, err := FindBinary()
	return err == nil
}

type Snapshot struct {
	ID       string    `json:"id"`
	Time     time.Time `json:"time"`
	Tree     string    `json:"tree"`
	Paths    []string  `json:"paths"`
	Hostname string    `json:"hostname"`
	Username string    `json:"username"`
	Tags     []string  `json:"tags"`
	Parent   string    `json:"parent"`
}

type BackupSummary struct {
	SnapshotID   string  `json:"snapshot_id"`
	DataAdded    int64   `json:"data_added"`
	TotalFiles   int     `json:"total_files_processed"`
	TotalBytes   int64   `json:"total_bytes_processed"`
	NewFiles     int     `json:"new_files,omitempty"`
	ChangedFiles int     `json:"changed_files,omitempty"`
	Unchanged    int     `json:"unchanged_files,omitempty"`
	Duration     float64 `json:"total_duration"`
}

type ProgressInfo struct {
	PercentDone      float64  `json:"percent_done"`
	TotalFiles       int      `json:"total_files"`
	FilesDone        int      `json:"files_done"`
	TotalBytes       int64    `json:"total_bytes"`
	BytesDone        int64    `json:"bytes_done"`
	CurrentFiles     []string `json:"current_files"`
	SecondsElapsed   float64  `json:"seconds_elapsed"`
	SecondsRemaining float64  `json:"seconds_remaining"`
}

type ForgetResult struct {
	Keep   []SnapshotID `json:"keep"`
	Remove []SnapshotID `json:"remove"`
}

type SnapshotID struct {
	ID       string    `json:"id"`
	Time     time.Time `json:"time"`
	Hostname string    `json:"hostname"`
	Tags     []string  `json:"tags"`
	Paths    []string  `json:"paths"`
}

type RepoConfig struct {
	Type              string
	Path              string
	Password          string
	Env               map[string]string
	LimitUploadKbps   int
	LimitDownloadKbps int
}

type Engine struct {
	binaryPath string
	logger     *slog.Logger
}

func NewEngine() (*Engine, error) {
	binPath, err := FindBinary()
	if err != nil {
		return nil, err
	}
	return &Engine{
		binaryPath: binPath,
		logger:     slog.Default().With("component", "restic"),
	}, nil
}

func (e *Engine) buildCmd(ctx context.Context, repo RepoConfig, args ...string) (*exec.Cmd, string, error) {
	pwFile, err := e.writePasswordFile(repo.Password)
	if err != nil {
		return nil, "", fmt.Errorf("create password file: %w", err)
	}
	allArgs := append([]string{"--repo", repo.Path, "--password-file", pwFile, "--json"}, args...)
	allArgs = e.appendLimitArgs(allArgs, repo)
	cmd := exec.CommandContext(ctx, e.binaryPath, allArgs...)
	cmd.Env = os.Environ()
	for k, v := range repo.Env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	return cmd, pwFile, nil
}

func (e *Engine) buildCmdNoJSON(ctx context.Context, repo RepoConfig, args ...string) (*exec.Cmd, string, error) {
	pwFile, err := e.writePasswordFile(repo.Password)
	if err != nil {
		return nil, "", fmt.Errorf("create password file: %w", err)
	}
	allArgs := append([]string{"--repo", repo.Path, "--password-file", pwFile}, args...)
	allArgs = e.appendLimitArgs(allArgs, repo)
	cmd := exec.CommandContext(ctx, e.binaryPath, allArgs...)
	cmd.Env = os.Environ()
	for k, v := range repo.Env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	return cmd, pwFile, nil
}

func (e *Engine) writePasswordFile(password string) (string, error) {
	tmpFile, err := os.CreateTemp("", "restic-pw-")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}

	if _, err := tmpFile.WriteString(password); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return "", fmt.Errorf("write password: %w", err)
	}

	name := tmpFile.Name()
	tmpFile.Close()
	os.Chmod(name, 0600)
	return name, nil
}

func (e *Engine) appendLimitArgs(args []string, repo RepoConfig) []string {
	if repo.LimitUploadKbps > 0 {
		args = append(args, "--limit-upload", fmt.Sprintf("%d", repo.LimitUploadKbps))
	}
	if repo.LimitDownloadKbps > 0 {
		args = append(args, "--limit-download", fmt.Sprintf("%d", repo.LimitDownloadKbps))
	}
	return args
}

func (e *Engine) Init(ctx context.Context, repo RepoConfig) error {
	cmd, pwFile, err := e.buildCmd(ctx, repo, "init")
	if err != nil {
		return err
	}
	defer os.Remove(pwFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "already initialized") {
			return nil
		}
		return fmt.Errorf("restic init failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

var pathRegex = regexp.MustCompile(`^[a-zA-Z0-9._/\-:]+$`)

func (e *Engine) Backup(ctx context.Context, repo RepoConfig, paths []string, tags []string, excludePatterns []string) (*BackupSummary, error) {
	for _, p := range paths {
		if !pathRegex.MatchString(p) {
			return nil, fmt.Errorf("invalid backup path: %q", p)
		}
	}

	args := []string{"backup"}
	for _, p := range paths {
		args = append(args, p)
	}
	for _, t := range tags {
		if !pathRegex.MatchString(t) {
			return nil, fmt.Errorf("invalid tag: %q", t)
		}
		args = append(args, "--tag", t)
	}
	for _, ex := range excludePatterns {
		args = append(args, "--exclude", ex)
	}

	cmd, pwFile, err := e.buildCmd(ctx, repo, args...)
	if err != nil {
		return nil, fmt.Errorf("restic backup build: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup start: %w", err)
	}

	var summary BackupSummary
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		var msg map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msgType, ok := msg["message_type"]; ok {
			var mt string
			if err := json.Unmarshal(msgType, &mt); err == nil && mt == "summary" {
				json.Unmarshal([]byte(line), &summary)
			}
		}
	}

	errOutput, _ := io.ReadAll(stderr)
	waitErr := cmd.Wait()
	os.Remove(pwFile)

	if waitErr != nil {
		return nil, fmt.Errorf("restic backup failed: %w\nstderr: %s", waitErr, string(errOutput))
	}

	return &summary, nil
}

func (e *Engine) BackupWithProgress(ctx context.Context, repo RepoConfig, paths []string, tags []string, excludePatterns []string, progressCh chan<- ProgressInfo) (*BackupSummary, error) {
	defer close(progressCh)

	for _, p := range paths {
		if !pathRegex.MatchString(p) {
			return nil, fmt.Errorf("invalid backup path: %q", p)
		}
	}

	args := []string{"backup"}
	for _, p := range paths {
		args = append(args, p)
	}
	for _, t := range tags {
		args = append(args, "--tag", t)
	}
	for _, ex := range excludePatterns {
		args = append(args, "--exclude", ex)
	}

	cmd, pwFile, err := e.buildCmd(ctx, repo, args...)
	if err != nil {
		return nil, fmt.Errorf("restic backup build: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		os.Remove(pwFile)
		return nil, fmt.Errorf("restic backup start: %w", err)
	}

	var summary BackupSummary
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		var msg map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		if msgType, ok := msg["message_type"]; ok {
			var mt string
			if err := json.Unmarshal(msgType, &mt); err != nil {
				continue
			}
			switch mt {
			case "status":
				var pi ProgressInfo
				if err := json.Unmarshal([]byte(line), &pi); err == nil && progressCh != nil {
					select {
					case progressCh <- pi:
					default:
					}
				}
			case "summary":
				json.Unmarshal([]byte(line), &summary)
			}
		}
	}

	errOutput, _ := io.ReadAll(stderr)
	waitErr := cmd.Wait()
	os.Remove(pwFile)

	if waitErr != nil {
		return nil, fmt.Errorf("restic backup failed: %w\nstderr: %s", waitErr, string(errOutput))
	}

	return &summary, nil
}

func (e *Engine) Restore(ctx context.Context, repo RepoConfig, snapshotID, targetPath string, includePaths []string) error {
	if !pathRegex.MatchString(targetPath) {
		return fmt.Errorf("invalid target path: %q", targetPath)
	}
	if !pathRegex.MatchString(snapshotID) {
		return fmt.Errorf("invalid snapshot ID: %q", snapshotID)
	}

	args := []string{"restore", snapshotID, "--target", targetPath}
	for _, p := range includePaths {
		if !pathRegex.MatchString(p) {
			return fmt.Errorf("invalid include path: %q", p)
		}
		args = append(args, "--include", p)
	}

	cmd, pwFile, err := e.buildCmdNoJSON(ctx, repo, args...)
	if err != nil {
		return fmt.Errorf("restic restore build: %w", err)
	}
	defer os.Remove(pwFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic restore failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

func (e *Engine) Snapshots(ctx context.Context, repo RepoConfig) ([]Snapshot, error) {
	cmd, pwFile, err := e.buildCmd(ctx, repo, "snapshots")
	if err != nil {
		return nil, err
	}
	defer os.Remove(pwFile)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("restic snapshots failed: %w", err)
	}

	var snapshots []Snapshot
	if err := json.Unmarshal(output, &snapshots); err != nil {
		return nil, fmt.Errorf("failed to parse restic snapshots output: %w", err)
	}
	return snapshots, nil
}

func (e *Engine) Forget(ctx context.Context, repo RepoConfig, keepLast int, keepDaily, keepWeekly, keepMonthly int) (*ForgetResult, error) {
	args := []string{"forget"}
	if keepLast > 0 {
		args = append(args, "--keep-last", fmt.Sprintf("%d", keepLast))
	}
	if keepDaily > 0 {
		args = append(args, "--keep-daily", fmt.Sprintf("%d", keepDaily))
	}
	if keepWeekly > 0 {
		args = append(args, "--keep-weekly", fmt.Sprintf("%d", keepWeekly))
	}
	if keepMonthly > 0 {
		args = append(args, "--keep-monthly", fmt.Sprintf("%d", keepMonthly))
	}
	args = append(args, "--prune")

	cmd, pwFile, err := e.buildCmdNoJSON(ctx, repo, args...)
	if err != nil {
		return nil, fmt.Errorf("restic forget build: %w", err)
	}
	defer os.Remove(pwFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("restic forget failed: %w\noutput: %s", err, string(output))
	}

	var result ForgetResult
	if err := json.Unmarshal(output, &result); err != nil {
		e.logger.Warn("restic forget output not JSON, returning empty result", "error", err)
		return &result, nil
	}
	return &result, nil
}

func (e *Engine) ForgetSnapshot(ctx context.Context, repo RepoConfig, snapshotID string) error {
	cmd, pwFile, err := e.buildCmdNoJSON(ctx, repo, "forget", snapshotID, "--prune")
	if err != nil {
		return fmt.Errorf("restic forget build: %w", err)
	}
	defer os.Remove(pwFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic forget %s: %w\noutput: %s", snapshotID, err, string(output))
	}
	return nil
}

func (e *Engine) Check(ctx context.Context, repo RepoConfig) error {
	cmd, pwFile, err := e.buildCmdNoJSON(ctx, repo, "check")
	if err != nil {
		return err
	}
	defer os.Remove(pwFile)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restic check failed: %w\noutput: %s", err, string(output))
	}
	return nil
}

func (e *Engine) Stats(ctx context.Context, repo RepoConfig) (map[string]interface{}, error) {
	cmd, pwFile, err := e.buildCmd(ctx, repo, "stats")
	if err != nil {
		return nil, err
	}
	defer os.Remove(pwFile)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("restic stats failed: %w", err)
	}

	var stats map[string]interface{}
	if err := json.Unmarshal(output, &stats); err != nil {
		return nil, fmt.Errorf("failed to parse restic stats: %w", err)
	}
	return stats, nil
}

func (e *Engine) EnsureRepoDir(repo RepoConfig) error {
	if repo.Type == "local" {
		return os.MkdirAll(repo.Path, 0750)
	}
	return nil
}

func (e *Engine) EnsureLocalRepo(ctx context.Context, repo RepoConfig) error {
	if err := e.EnsureRepoDir(repo); err != nil {
		return fmt.Errorf("create repo directory: %w", err)
	}
	if err := e.Init(ctx, repo); err != nil {
		return fmt.Errorf("init repo: %w", err)
	}
	return nil
}

package restic

import (
	"bytes"
	"compress/bzip2"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// newStubEngine returns an Engine backed by a stub "restic" script instead of
// the real binary, plus the path of the file the stub writes its argv to.
func newStubEngine(t *testing.T, script string) (*Engine, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("stub restic binary requires a POSIX shell")
	}

	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args.txt")
	binPath := filepath.Join(dir, "restic")
	body := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %q\n%s\n", argsFile, script)
	if err := os.WriteFile(binPath, []byte(body), 0700); err != nil {
		t.Fatalf("write stub binary: %v", err)
	}

	return &Engine{binaryPath: binPath, logger: slog.Default()}, argsFile
}

func stubArgs(t *testing.T, argsFile string) []string {
	t.Helper()
	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read stub args: %v", err)
	}
	return strings.Fields(string(data))
}

func localRepo(t *testing.T) RepoConfig {
	t.Helper()
	return RepoConfig{Type: "local", Path: filepath.Join(t.TempDir(), "repo"), Password: "pw"}
}

func TestEngine_WritePasswordFile(t *testing.T) {
	e := &Engine{binaryPath: "restic", logger: slog.Default()}

	name, err := e.writePasswordFile("s3cr3t")
	if err != nil {
		t.Fatalf("writePasswordFile: %v", err)
	}
	defer os.Remove(name)

	content, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read password file: %v", err)
	}
	if string(content) != "s3cr3t" {
		t.Errorf("password file content = %q, want s3cr3t", content)
	}
	if dir := filepath.Base(filepath.Dir(name)); dir != "libreserv-restic-pw" {
		t.Errorf("password file parent dir = %q, want libreserv-restic-pw", dir)
	}

	info, err := os.Stat(name)
	if err != nil {
		t.Fatalf("stat password file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Errorf("password file mode = %v, want 0600", perm)
	}
}

func TestEngine_AppendLimitArgs(t *testing.T) {
	e := &Engine{}

	if got := e.appendLimitArgs([]string{"backup"}, RepoConfig{}); len(got) != 1 {
		t.Errorf("args with no limits = %v, want them unchanged", got)
	}

	got := e.appendLimitArgs([]string{"backup"}, RepoConfig{LimitUploadKbps: 512, LimitDownloadKbps: 1024})
	want := []string{"backup", "--limit-upload", "512", "--limit-download", "1024"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("args = %v, want %v", got, want)
	}
}

func TestEngine_BuildCmd(t *testing.T) {
	e := &Engine{binaryPath: "/usr/bin/restic", logger: slog.Default()}
	repo := RepoConfig{
		Type:            "s3",
		Path:            "s3:bucket/app",
		Password:        "pw",
		Env:             map[string]string{"AWS_ACCESS_KEY_ID": "key-id"},
		LimitUploadKbps: 100,
	}

	cmd, pwFile, err := e.buildCmd(context.Background(), repo, "snapshots")
	if err != nil {
		t.Fatalf("buildCmd: %v", err)
	}
	defer os.Remove(pwFile)

	args := strings.Join(cmd.Args, " ")
	for _, want := range []string{"--repo s3:bucket/app", "--password-file " + pwFile, "--json", "snapshots", "--limit-upload 100"} {
		if !strings.Contains(args, want) {
			t.Errorf("command args %q are missing %q", args, want)
		}
	}
	if !containsEnv(cmd.Env, "AWS_ACCESS_KEY_ID=key-id") {
		t.Error("repo env was not passed to the command")
	}

	noJSON, pwFile2, err := e.buildCmdNoJSON(context.Background(), repo, "check")
	if err != nil {
		t.Fatalf("buildCmdNoJSON: %v", err)
	}
	defer os.Remove(pwFile2)
	if strings.Contains(strings.Join(noJSON.Args, " "), "--json") {
		t.Errorf("buildCmdNoJSON args = %v, want no --json flag", noJSON.Args)
	}
}

func containsEnv(env []string, want string) bool {
	for _, kv := range env {
		if kv == want {
			return true
		}
	}
	return false
}

func TestCleanupLeakedPasswordFiles(t *testing.T) {
	pwDir := filepath.Join(os.TempDir(), "libreserv-restic-pw")
	if err := os.MkdirAll(pwDir, 0700); err != nil {
		t.Fatalf("create password dir: %v", err)
	}

	stale, err := os.CreateTemp(pwDir, "pw-stale-")
	if err != nil {
		t.Fatalf("create stale file: %v", err)
	}
	_ = stale.Close()
	staleName := stale.Name()
	t.Cleanup(func() { os.Remove(staleName) })
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(staleName, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	fresh, err := os.CreateTemp(pwDir, "pw-fresh-")
	if err != nil {
		t.Fatalf("create fresh file: %v", err)
	}
	_ = fresh.Close()
	freshName := fresh.Name()
	t.Cleanup(func() { os.Remove(freshName) })

	CleanupLeakedPasswordFiles()

	if _, err := os.Stat(staleName); !os.IsNotExist(err) {
		t.Errorf("stale password file still exists (err %v), want it removed", err)
	}
	if _, err := os.Stat(freshName); err != nil {
		t.Errorf("fresh password file was removed (err %v), want it kept", err)
	}
}

func TestEngine_Init(t *testing.T) {
	e, argsFile := newStubEngine(t, "exit 0")
	repo := localRepo(t)

	if err := e.Init(context.Background(), repo); err != nil {
		t.Fatalf("Init: %v", err)
	}
	args := stubArgs(t, argsFile)
	if args[len(args)-1] != "init" {
		t.Errorf("stub args = %v, want them to end with init", args)
	}
}

func TestEngine_Init_AlreadyInitializedIsNotAnError(t *testing.T) {
	e, _ := newStubEngine(t, "echo 'Fatal: config file already initialized'; exit 1")

	if err := e.Init(context.Background(), localRepo(t)); err != nil {
		t.Fatalf("Init on an initialized repo = %v, want nil", err)
	}
}

func TestEngine_Init_Failure(t *testing.T) {
	e, _ := newStubEngine(t, "echo 'Fatal: unable to open repo'; exit 1")

	if err := e.Init(context.Background(), localRepo(t)); err == nil {
		t.Fatal("Init = nil error, want the restic failure")
	}
}

func TestEngine_EnsureLocalRepo_CreatesDirectory(t *testing.T) {
	e, _ := newStubEngine(t, "exit 0")
	repo := localRepo(t)

	if err := e.EnsureLocalRepo(context.Background(), repo); err != nil {
		t.Fatalf("EnsureLocalRepo: %v", err)
	}
	if info, err := os.Stat(repo.Path); err != nil || !info.IsDir() {
		t.Fatalf("repo dir = %v (err %v), want a directory", info, err)
	}

	// Non-local repos are left alone.
	if err := e.EnsureRepoDir(RepoConfig{Type: "s3", Path: "s3:bucket"}); err != nil {
		t.Errorf("EnsureRepoDir for s3 = %v, want nil", err)
	}
}

func TestEngine_Backup_ParsesSummaryAndCleansUpPasswordFile(t *testing.T) {
	summary := `{"message_type":"status","percent_done":0.5}
not-json
{"message_type":"summary","snapshot_id":"abc123","data_added":2048,"total_files_processed":3,"total_bytes_processed":4096,"total_duration":1.5}`
	e, argsFile := newStubEngine(t, "cat <<'EOF'\n"+summary+"\nEOF")
	before := passwordFileNames(t)

	got, err := e.Backup(context.Background(), localRepo(t), []string{"/data/app"}, []string{"daily"}, []string{"*.log"})
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if got.SnapshotID != "abc123" || got.DataAdded != 2048 || got.TotalFiles != 3 {
		t.Errorf("summary = %+v, want snapshot abc123 with 2048 bytes added and 3 files", got)
	}

	args := stubArgs(t, argsFile)
	joined := strings.Join(args, " ")
	for _, want := range []string{"backup", "/data/app", "--tag daily", "--exclude *.log"} {
		if !strings.Contains(joined, want) {
			t.Errorf("stub args %q are missing %q", joined, want)
		}
	}

	for name := range passwordFileNames(t) {
		if !before[name] {
			t.Errorf("password file %q was left behind by Backup", name)
		}
	}
}

func passwordFileNames(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(os.TempDir(), "libreserv-restic-pw"))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]bool{}
		}
		t.Fatalf("read password dir: %v", err)
	}
	names := make(map[string]bool, len(entries))
	for _, entry := range entries {
		names[entry.Name()] = true
	}
	return names
}

func TestEngine_Backup_RejectsUnsafePathsAndTags(t *testing.T) {
	e, _ := newStubEngine(t, "exit 0")
	repo := localRepo(t)

	if _, err := e.Backup(context.Background(), repo, []string{"$(whoami)"}, nil, nil); err == nil {
		t.Error("Backup with an injected path = nil error, want a validation error")
	}
	if _, err := e.Backup(context.Background(), repo, []string{"/data"}, []string{"; rm -rf /"}, nil); err == nil {
		t.Error("Backup with an injected tag = nil error, want a validation error")
	}
}

func TestEngine_Backup_Failure(t *testing.T) {
	e, _ := newStubEngine(t, "echo 'repository is locked' >&2; exit 1")

	_, err := e.Backup(context.Background(), localRepo(t), []string{"/data"}, nil, nil)
	if err == nil {
		t.Fatal("Backup = nil error, want the restic failure")
	}
	if !strings.Contains(err.Error(), "repository is locked") {
		t.Errorf("error = %v, want it to include the restic stderr", err)
	}
}

func TestEngine_BackupWithProgress(t *testing.T) {
	output := `{"message_type":"status","percent_done":0.25,"files_done":1,"total_files":4}
{"message_type":"summary","snapshot_id":"snap-1","total_files_processed":4}`
	e, _ := newStubEngine(t, "cat <<'EOF'\n"+output+"\nEOF")

	progressCh := make(chan ProgressInfo, 8)
	got, err := e.BackupWithProgress(context.Background(), localRepo(t), []string{"/data"}, []string{"daily"}, nil, progressCh)
	if err != nil {
		t.Fatalf("BackupWithProgress: %v", err)
	}
	if got.SnapshotID != "snap-1" {
		t.Errorf("snapshot ID = %q, want snap-1", got.SnapshotID)
	}

	var progress []ProgressInfo
	for pi := range progressCh { // BackupWithProgress closes the channel
		progress = append(progress, pi)
	}
	if len(progress) != 1 || progress[0].PercentDone != 0.25 || progress[0].FilesDone != 1 {
		t.Errorf("progress = %+v, want a single 25%% update", progress)
	}
}

func TestEngine_BackupWithProgress_RejectsUnsafePaths(t *testing.T) {
	e, _ := newStubEngine(t, "exit 0")
	progressCh := make(chan ProgressInfo, 1)

	if _, err := e.BackupWithProgress(context.Background(), localRepo(t), []string{"bad path"}, nil, nil, progressCh); err == nil {
		t.Fatal("BackupWithProgress = nil error, want a validation error")
	}
	if _, ok := <-progressCh; ok {
		t.Error("progress channel was not closed on the validation error")
	}
}

func TestEngine_Restore(t *testing.T) {
	e, argsFile := newStubEngine(t, "exit 0")
	repo := localRepo(t)

	if err := e.Restore(context.Background(), repo, "snap-1", "/restore/target", []string{"/data/app"}); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	joined := strings.Join(stubArgs(t, argsFile), " ")
	for _, want := range []string{"restore snap-1", "--target /restore/target", "--include /data/app"} {
		if !strings.Contains(joined, want) {
			t.Errorf("stub args %q are missing %q", joined, want)
		}
	}
	if strings.Contains(joined, "--json") {
		t.Errorf("restore args %q contain --json, want the plain output form", joined)
	}
}

func TestEngine_Restore_Validation(t *testing.T) {
	e, _ := newStubEngine(t, "exit 0")
	repo := localRepo(t)
	ctx := context.Background()

	if err := e.Restore(ctx, repo, "snap-1", "bad target", nil); err == nil {
		t.Error("Restore with an invalid target = nil error, want a validation error")
	}
	if err := e.Restore(ctx, repo, "snap 1", "/target", nil); err == nil {
		t.Error("Restore with an invalid snapshot ID = nil error, want a validation error")
	}
	if err := e.Restore(ctx, repo, "snap-1", "/target", []string{"$(id)"}); err == nil {
		t.Error("Restore with an invalid include path = nil error, want a validation error")
	}
}

func TestEngine_Snapshots(t *testing.T) {
	list := `[{"id":"snap-1","time":"2026-01-02T03:04:05Z","paths":["/data"],"tags":["daily"]}]`
	e, _ := newStubEngine(t, "echo '"+list+"'")

	got, err := e.Snapshots(context.Background(), localRepo(t))
	if err != nil {
		t.Fatalf("Snapshots: %v", err)
	}
	if len(got) != 1 || got[0].ID != "snap-1" || got[0].Tags[0] != "daily" {
		t.Errorf("snapshots = %+v, want one snap-1 tagged daily", got)
	}
}

func TestEngine_Snapshots_Errors(t *testing.T) {
	e, _ := newStubEngine(t, "exit 1")
	if _, err := e.Snapshots(context.Background(), localRepo(t)); err == nil {
		t.Error("Snapshots = nil error, want the restic failure")
	}

	e, _ = newStubEngine(t, "echo not-json")
	if _, err := e.Snapshots(context.Background(), localRepo(t)); err == nil {
		t.Error("Snapshots with unparsable output = nil error, want a parse error")
	}
}

func TestEngine_Forget(t *testing.T) {
	result := `{"keep":[{"id":"snap-2"}],"remove":[{"id":"snap-1"}]}`
	e, argsFile := newStubEngine(t, "echo '"+result+"'")

	got, err := e.Forget(context.Background(), localRepo(t), 2, 7, 4, 6)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if len(got.Keep) != 1 || got.Keep[0].ID != "snap-2" || len(got.Remove) != 1 || got.Remove[0].ID != "snap-1" {
		t.Errorf("result = %+v, want snap-2 kept and snap-1 removed", got)
	}

	joined := strings.Join(stubArgs(t, argsFile), " ")
	for _, want := range []string{"forget", "--keep-last 2", "--keep-daily 7", "--keep-weekly 4", "--keep-monthly 6", "--prune"} {
		if !strings.Contains(joined, want) {
			t.Errorf("stub args %q are missing %q", joined, want)
		}
	}
}

func TestEngine_Forget_NonJSONOutputIsTolerated(t *testing.T) {
	e, argsFile := newStubEngine(t, "echo 'no snapshots to remove'")

	got, err := e.Forget(context.Background(), localRepo(t), 0, 0, 0, 0)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if len(got.Keep) != 0 || len(got.Remove) != 0 {
		t.Errorf("result = %+v, want an empty result", got)
	}
	if joined := strings.Join(stubArgs(t, argsFile), " "); strings.Contains(joined, "--keep-last") {
		t.Errorf("stub args %q contain retention flags, want none when all counts are zero", joined)
	}
}

func TestEngine_Forget_Failure(t *testing.T) {
	e, _ := newStubEngine(t, "exit 1")
	if _, err := e.Forget(context.Background(), localRepo(t), 1, 0, 0, 0); err == nil {
		t.Error("Forget = nil error, want the restic failure")
	}
}

func TestEngine_ForgetSnapshot(t *testing.T) {
	e, argsFile := newStubEngine(t, "exit 0")

	if err := e.ForgetSnapshot(context.Background(), localRepo(t), "snap-1"); err != nil {
		t.Fatalf("ForgetSnapshot: %v", err)
	}
	if joined := strings.Join(stubArgs(t, argsFile), " "); !strings.Contains(joined, "forget snap-1 --prune") {
		t.Errorf("stub args = %q, want 'forget snap-1 --prune'", joined)
	}

	e, _ = newStubEngine(t, "exit 1")
	if err := e.ForgetSnapshot(context.Background(), localRepo(t), "snap-1"); err == nil {
		t.Error("ForgetSnapshot = nil error, want the restic failure")
	}
}

func TestEngine_Check(t *testing.T) {
	e, argsFile := newStubEngine(t, "exit 0")
	if err := e.Check(context.Background(), localRepo(t)); err != nil {
		t.Fatalf("Check: %v", err)
	}
	if joined := strings.Join(stubArgs(t, argsFile), " "); !strings.Contains(joined, "check") {
		t.Errorf("stub args = %q, want the check subcommand", joined)
	}

	e, _ = newStubEngine(t, "echo 'repository contains errors'; exit 1")
	if err := e.Check(context.Background(), localRepo(t)); err == nil {
		t.Error("Check = nil error, want the restic failure")
	}
}

func TestEngine_Stats(t *testing.T) {
	e, _ := newStubEngine(t, `echo '{"total_size":1024,"total_file_count":7}'`)

	got, err := e.Stats(context.Background(), localRepo(t))
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if got["total_size"] != float64(1024) || got["total_file_count"] != float64(7) {
		t.Errorf("stats = %v, want total_size 1024 and total_file_count 7", got)
	}

	e, _ = newStubEngine(t, "echo not-json")
	if _, err := e.Stats(context.Background(), localRepo(t)); err == nil {
		t.Error("Stats with unparsable output = nil error, want a parse error")
	}
}

func TestDecompressBz2(t *testing.T) {
	dir := t.TempDir()
	bz2Path := filepath.Join(dir, "restic.bz2")
	// A bzip2 stream produced by the reference implementation for "libreserv".
	if err := os.WriteFile(bz2Path, bzipFixture(t, "libreserv"), 0600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	if err := decompressBz2(bz2Path); err != nil {
		t.Fatalf("decompressBz2: %v", err)
	}

	out := filepath.Join(dir, "restic")
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read decompressed file: %v", err)
	}
	if string(data) != "libreserv" {
		t.Errorf("decompressed content = %q, want libreserv", data)
	}
	if _, err := os.Stat(bz2Path); !os.IsNotExist(err) {
		t.Errorf("compressed file still exists (err %v), want it removed", err)
	}
}

func TestDecompressBz2_Errors(t *testing.T) {
	if err := decompressBz2(filepath.Join(t.TempDir(), "missing.bz2")); err == nil {
		t.Error("decompressBz2 on a missing file = nil error, want an error")
	}

	bad := filepath.Join(t.TempDir(), "bad.bz2")
	if err := os.WriteFile(bad, []byte("not bzip2 data"), 0600); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if err := decompressBz2(bad); err == nil {
		t.Error("decompressBz2 on a corrupt archive = nil error, want an error")
	}
	if _, err := os.Stat(strings.TrimSuffix(bad, ".bz2")); !os.IsNotExist(err) {
		t.Error("the partial output file was left behind after a failed decompression")
	}
}

// bzipFixture returns a bzip2 stream for the given payload. The standard
// library only ships a bzip2 reader, so the fixture is a known-good stream
// checked by decompressing it here before use.
func bzipFixture(t *testing.T, want string) []byte {
	t.Helper()
	// bzip2 -9 stream for "libreserv".
	stream := []byte{
		0x42, 0x5a, 0x68, 0x39, 0x31, 0x41, 0x59, 0x26, 0x53, 0x59, 0x5b, 0xe3,
		0x2d, 0x0c, 0x00, 0x00, 0x02, 0x01, 0x80, 0x12, 0x24, 0x19, 0x00, 0x20,
		0x00, 0x31, 0x0c, 0x01, 0x06, 0x9b, 0x42, 0x02, 0x13, 0x1d, 0x17, 0x72,
		0x45, 0x38, 0x50, 0x90, 0x5b, 0xe3, 0x2d, 0x0c,
	}
	got, err := readAllBzip2(stream)
	if err != nil || got != want {
		t.Fatalf("bzip2 fixture decodes to %q (err %v), want %q", got, err, want)
	}
	return stream
}

func readAllBzip2(stream []byte) (string, error) {
	var out bytes.Buffer
	if _, err := out.ReadFrom(bzip2.NewReader(bytes.NewReader(stream))); err != nil {
		return "", err
	}
	return out.String(), nil
}

package sandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNormalizeMode(t *testing.T) {
	cases := map[string]Mode{
		"":           ModeAuto,
		"auto":       ModeAuto,
		"AUTO":       ModeAuto,
		"bwrap":      ModeBwrap,
		"BubbleWrap": ModeBwrap,
		"bubble":     ModeBwrap,
		"off":        ModeOff,
		"none":       ModeOff,
		"disabled":   ModeOff,
		"garbage":    ModeAuto, // unknown → auto
	}
	for in, want := range cases {
		if got := normalizeMode(in); got != want {
			t.Errorf("normalizeMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNewSelectsBackend(t *testing.T) {
	off := New(Config{Mode: "off"})
	if off.Mode() != ModeOff {
		t.Errorf("mode=off → Mode() = %q, want %q", off.Mode(), ModeOff)
	}
	if !off.Available() {
		t.Error("noneSandbox should always be available")
	}

	bwrap := New(Config{Mode: "bwrap"})
	if bwrap.Mode() != ModeBwrap {
		t.Errorf("mode=bwrap → Mode() = %q, want %q", bwrap.Mode(), ModeBwrap)
	}
	// bwrap is installed in this dev environment; auto should pick it.
	if bwrapAvail() && !bwrap.Available() {
		t.Error("bwrap backend reports unavailable despite bwrap being on PATH")
	}

	auto := New(Config{Mode: "auto"})
	if bwrapAvail() {
		if auto.Mode() != ModeBwrap {
			t.Errorf("auto with bwrap present → Mode() = %q, want %q", auto.Mode(), ModeBwrap)
		}
	} else {
		if auto.Mode() != ModeOff {
			t.Errorf("auto without bwrap → Mode() = %q, want %q (none fallback)", auto.Mode(), ModeOff)
		}
	}
}

func bwrapAvail() bool { return commandExists("bwrap") }

func TestBuildBwrapArgs_RequiresCommand(t *testing.T) {
	_, err := buildBwrapArgs(Config{}, CommandSpec{Command: "   "})
	if err != errEmptyCommand {
		t.Errorf("expected errEmptyCommand, got %v", err)
	}
}

func TestBuildBwrapArgs_CoreShape(t *testing.T) {
	tmp := t.TempDir()
	cfg := Config{
		Mode:     "bwrap",
		Workdirs: []string{tmp, "/var/lib/libreserv"},
		Network:  true,
	}
	args, err := buildBwrapArgs(cfg, CommandSpec{Command: "echo hi", Workdir: tmp})
	if err != nil {
		t.Fatalf("buildBwrapArgs: %v", err)
	}

	joined := strings.Join(args, "\x00")

	// Must isolate namespaces.
	for _, flag := range []string{"--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-cgroup"} {
		if !strings.Contains(joined, flag+"\x00") {
			t.Errorf("missing namespace flag %q", flag)
		}
	}
	// Read-only host root is the core boundary.
	if !strings.Contains(joined, "--ro-bind\x00/\x00/\x00") {
		t.Error("missing read-only bind of host root")
	}
	// Die with parent + new session.
	if !strings.Contains(joined, "--die-with-parent") || !strings.Contains(joined, "--new-session") {
		t.Error("missing --die-with-parent / --new-session")
	}
	// Clean env + minimal setenv.
	if !strings.Contains(joined, "--clearenv") {
		t.Error("missing --clearenv (host env would leak)")
	}
	if !strings.Contains(joined, "HOME\x00"+tmp) {
		t.Errorf("HOME should point at workdir %s", tmp)
	}
	if !strings.Contains(joined, "PATH\x00"+defaultPath) {
		t.Error("PATH env not set to defaultPath")
	}
	// Network shared → no --unshare-net.
	if strings.Contains(joined, "--unshare-net") {
		t.Error("Network=true should NOT add --unshare-net")
	}
	// Command runs via bash -c.
	if !strings.Contains(joined, "--\x00bash\x00-c\x00echo hi") {
		t.Error("command not appended as `-- bash -c <cmd>`")
	}
	// Workdir is the chdir target.
	if !strings.Contains(joined, "--chdir\x00"+tmp) {
		t.Errorf("missing --chdir %s", tmp)
	}
}

func TestBuildBwrapArgs_NetworkOffAddsUnshareNet(t *testing.T) {
	args, err := buildBwrapArgs(Config{Network: false}, CommandSpec{Command: "echo hi"})
	if err != nil {
		t.Fatalf("buildBwrapArgs: %v", err)
	}
	joined := strings.Join(args, "\x00")
	if !strings.Contains(joined, "--unshare-net") {
		t.Error("Network=false should add --unshare-net")
	}
}

func TestBuildBwrapArgs_WorkdirsBoundAndDeduped(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	// Duplicate (after cleaning) and an absolute-but-nonexistent dir.
	cfg := Config{Workdirs: []string{a, a, "/this/does/not/exist"}}
	args, err := buildBwrapArgs(cfg, CommandSpec{Command: "echo hi", Workdir: a})
	if err != nil {
		t.Fatalf("buildBwrapArgs: %v", err)
	}
	joined := strings.Join(args, "\x00")
	if !strings.Contains(joined, "--bind\x00"+a+"\x00"+a) {
		t.Errorf("workdir %s not bound read-write", a)
	}
	if strings.Contains(joined, "/this/does/not/exist") {
		t.Error("nonexistent workdir should have been filtered out")
	}
	// b was never added; only a should be bound (plus no b reference).
	_ = b
}

func TestResolveWorkdir_DefaultsAndValidation(t *testing.T) {
	tmp := t.TempDir()

	// Empty → first configured workdir.
	got, err := resolveWorkdir(Config{Workdirs: []string{tmp}}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != tmp {
		t.Errorf("empty workdir should default to first Workdir, got %q", got)
	}

	// Empty with no Workdirs → /tmp.
	got, err = resolveWorkdir(Config{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "/tmp" {
		t.Errorf("empty workdir with no Workdirs should default to /tmp, got %q", got)
	}

	// Relative → rejected.
	if _, err := resolveWorkdir(Config{}, "relative/path"); err == nil {
		t.Error("relative workdir should be rejected")
	}

	// Nonexistent → rejected.
	if _, err := resolveWorkdir(Config{}, "/no/such/dir/here"); err == nil {
		t.Error("nonexistent workdir should be rejected")
	}

	// Existing dir → cleaned absolute path.
	got, err = resolveWorkdir(Config{}, tmp+"/")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != tmp {
		t.Errorf("trailing slash not cleaned: got %q want %q", got, tmp)
	}
}

func TestNormalizeWorkdirs(t *testing.T) {
	tmp := t.TempDir()
	nested := filepath.Join(tmp, "sub")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	// Mix of valid, relative, duplicate, nonexistent.
	out := normalizeWorkdirs([]string{tmp + "/", tmp, "relative", "/nonexistent/xyz", nested})
	// filepath.Clean + sort: tmp sorts before tmp/sub.
	want := []string{tmp, nested}
	if len(out) != 2 {
		t.Fatalf("got %d workdirs, want 2: %v", len(out), out)
	}
	for i := range want {
		if out[i] != want[i] {
			t.Errorf("out[%d] = %q, want %q", i, out[i], want[i])
		}
	}
}

// --- Live execution tests (skipped when bwrap is absent) ---

func TestBwrapRun_ReadOnlyRootBlocksWrites(t *testing.T) {
	if !bwrapAvail() {
		t.Skip("bwrap not installed; skipping live sandbox test")
	}
	sb := New(Config{Mode: "bwrap", Network: true})
	if !sb.Available() {
		t.Fatal("bwrap sandbox unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	res, err := sb.Run(ctx, CommandSpec{
		Command: `echo hi > /etc/bwrap_escape_test; echo "exit=$?"`,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	// The redirect to /etc must fail because the root filesystem is read-only.
	// The shell reports a non-zero exit for the failed redirection.
	if !strings.Contains(res.Stdout, "exit=1") {
		t.Errorf("expected the /etc write to fail (exit=1), got stdout=%q stderr=%q", res.Stdout, res.Stderr)
	}
	if !strings.Contains(res.Stderr, "Read-only file system") {
		t.Errorf("expected /etc write to be blocked as read-only, got stdout=%q stderr=%q", res.Stdout, res.Stderr)
	}
}

func TestBwrapRun_WorkdirWritableAndDefault(t *testing.T) {
	if !bwrapAvail() {
		t.Skip("bwrap not installed; skipping live sandbox test")
	}
	tmp := t.TempDir()
	sb := New(Config{Mode: "bwrap", Workdirs: []string{tmp}, Network: true})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// Writing inside a bound workdir succeeds, and HOME defaults to the workdir.
	res, err := sb.Run(ctx, CommandSpec{
		Command: `echo hello > marker.txt && cat marker.txt && echo "home=$HOME"`,
		Workdir: tmp,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Stdout, "hello") {
		t.Errorf("expected to write+read inside workdir, got %q", res.Stdout)
	}
	if !strings.Contains(res.Stdout, "home="+tmp) {
		t.Errorf("HOME should be workdir %q, got %q", tmp, res.Stdout)
	}
	// The marker file landed on the host (bind mount is shared).
	if _, err := os.Stat(filepath.Join(tmp, "marker.txt")); err != nil {
		t.Errorf("expected marker.txt on host in workdir: %v", err)
	}
}

func TestBwrapRun_RejectsBadWorkdir(t *testing.T) {
	if !bwrapAvail() {
		t.Skip("bwrap not installed; skipping live sandbox test")
	}
	sb := New(Config{Mode: "bwrap", Network: true})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := sb.Run(ctx, CommandSpec{Command: "echo hi", Workdir: "/no/such/dir/xyz"})
	if err == nil {
		t.Fatal("expected error for nonexistent workdir")
	}
}

func TestBwrapRun_TimeoutKillsProcessGroup(t *testing.T) {
	if !bwrapAvail() {
		t.Skip("bwrap not installed; skipping live sandbox test")
	}
	sb := New(Config{Mode: "bwrap", Network: true})
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	res, err := sb.Run(ctx, CommandSpec{Command: "sleep 30"})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if res.ExitCode != -1 {
		t.Errorf("expected exit code -1 on timeout, got %d", res.ExitCode)
	}
	// Give bwrap a moment to die, then assert no sleep 30 lingers.
	time.Sleep(300 * time.Millisecond)
	out, _ := exec.Command("bash", "-c", `pgrep -f "sleep 30"`).Output()
	if len(strings.TrimSpace(string(out))) != 0 {
		t.Errorf("orphaned child process survived timeout: %s", out)
	}
}

func TestNoneSandbox_RunsUnsandboxed(t *testing.T) {
	sb := New(Config{Mode: "off"})
	if sb.Mode() != ModeOff {
		t.Fatalf("want ModeOff, got %q", sb.Mode())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := sb.Run(ctx, CommandSpec{Command: "echo unsandboxed"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !strings.Contains(res.Stdout, "unsandboxed") {
		t.Errorf("expected output, got %q", res.Stdout)
	}
}

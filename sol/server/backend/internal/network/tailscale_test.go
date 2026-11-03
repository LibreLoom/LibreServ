package network

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestHeadscaleControlServerAndAuthURLValidation(t *testing.T) {
	got, err := normalizeControlServer("https://control.example:8443/")
	if err != nil || got != "https://control.example:8443" {
		t.Fatalf("control server: %q, %v", got, err)
	}
	for _, raw := range []string{"http://control.example", "https://user:pass@control.example", "https://control.example/path", "https://control.example/?x=1", "javascript:alert(1)"} {
		if _, err := normalizeControlServer(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	if !allowedTailscaleAuthURL("https://control.example:8443/register/node", got) || allowedTailscaleAuthURL("https://other.example/register/node", got) || allowedTailscaleAuthURL("https://login.tailscale.com.evil.example/x", "") || !allowedTailscaleAuthURL("https://login.tailscale.com/a/demo", "") {
		t.Fatal("invalid login URL policy")
	}
}

func TestHeadscaleHTTPSListenerAndPublicRejection(t *testing.T) {
	fixture := map[string]any{"Web": map[string]any{"sol.example.net:443": map[string]any{"Handlers": map[string]any{"/": map[string]any{"Proxy": "http://127.0.0.1:8080"}}}}, "AllowFunnel": map[string]any{"sol.example.net:443": false}}
	public, private := configuredURLsForControl(fixture, "https://sol.example.net", "http://127.0.0.1:8080", true)
	if public != "" || private != "https://sol.example.net" {
		t.Fatalf("got %q %q", public, private)
	}
	_, private = configuredURLsForControl(fixture, "https://other.example.net", "http://127.0.0.1:8080", true)
	if private != "" {
		t.Fatal("accepted a different node")
	}
	_, private = configuredURLsForControl(fixture, "https://sol.example.net", "http://127.0.0.1:9999", true)
	if private != "" {
		t.Fatal("accepted a different proxy")
	}
	fixture["AllowFunnel"] = map[string]any{"sol.example.net:443": true}
	public, private = configuredURLsForControl(fixture, "https://sol.example.net", "http://127.0.0.1:8080", true)
	if public != "" || private != "" {
		t.Fatal("accepted Headscale public listener")
	}
}

func TestHeadscaleIdentityCannotChangeServerAndUpUsesSavedServer(t *testing.T) {
	dir := t.TempDir()
	service := NewTailscaleService(dir, 8080)
	service.UnixListenerReady("/tmp/test-8080.sock", nil)
	if err := os.Mkdir(service.dir, 0700); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(service.dir, "tailscaled.state")
	if err := os.WriteFile(state, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ConnectWithControl("https://headscale.example"); err == nil || !strings.Contains(err.Error(), "Sign out") {
		t.Fatalf("identity switch: %v", err)
	}
	if got, err := os.ReadFile(state); err != nil || string(got) != "{}" {
		t.Fatalf("identity changed: %q, %v", got, err)
	}
	if err := os.WriteFile(filepath.Join(service.dir, "control-server"), []byte("https://headscale.example"), 0600); err != nil {
		t.Fatal(err)
	}
	cli, calls := filepath.Join(dir, "cli"), filepath.Join(dir, "calls")
	writeExecutable(t, cli, `echo "$*" > "$TS_CALLS"`)
	t.Setenv("SOL_TAILSCALE_CLI", cli)
	t.Setenv("TS_CALLS", calls)
	if err := service.up(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(calls)
	if err != nil || !strings.Contains(string(got), "--login-server=https://headscale.example") {
		t.Fatalf("up args: %q, %v", got, err)
	}
	if _, err := service.Serve(true); err == nil || !strings.Contains(err.Error(), "not available") {
		t.Fatalf("public access: %v", err)
	}
}

func TestHeadscaleSelectionPersistsBeforeDaemonStart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
	s := NewTailscaleService(dir, 8080)
	s.UnixListenerReady("/tmp/test-8080.sock", nil)
	if _, err := s.ConnectWithControl("https://headscale.example/"); err == nil {
		t.Fatal("expected the missing daemon to fail")
	}
	if got, err := s.controlServer(); err != nil || got != "https://headscale.example" {
		t.Fatalf("selection: %q %v", got, err)
	}
	if tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		t.Fatal("enabled a missing daemon")
	}
}

func TestTailscaleShutdownRejectsLaterStartRequests(t *testing.T) {
	dir := t.TempDir()
	cli, calls := filepath.Join(dir, "cli"), filepath.Join(dir, "calls")
	writeExecutable(t, cli, `echo "$*" >> "$TS_CALLS"`)
	t.Setenv("SOL_TAILSCALE_CLI", cli)
	t.Setenv("TS_CALLS", calls)
	svc := NewTailscaleService(dir, 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	if err := svc.StopForShutdown(); err != nil {
		t.Fatal(err)
	}
	// These requests may have arrived before HTTP finishes shutting down.
	requests := []func() (TailscaleStatus, error){svc.Connect, svc.Reconnect, func() (TailscaleStatus, error) { return svc.Serve(true) }}
	done := make(chan error, len(requests))
	for _, request := range requests {
		go func() { _, err := request(); done <- err }()
	}
	for range requests {
		if err := <-done; err == nil || !strings.Contains(err.Error(), "shutting down") {
			t.Fatalf("start after shutdown: %v", err)
		}
	}
	if tailscaleFileExists(calls) || tailscaleFileExists(filepath.Join(svc.dir, "enabled")) {
		t.Fatal("shutdown request ran CLI or restored opt-in")
	}
}

func TestTailscaleRestoreClearsOldTargetBeforeWaitingForOwnedWebListener(t *testing.T) {
	for _, public := range []bool{false, true} {
		t.Run(strconv.FormatBool(public), func(t *testing.T) {
			dir := t.TempDir()
			node := filepath.Join(dir, "tailscale")
			if err := os.Mkdir(node, 0700); err != nil {
				t.Fatal(err)
			}
			config := map[string]any{"Web": map[string]any{"sol.tail-example.ts.net:443": map[string]any{"Handlers": map[string]any{"/": map[string]string{"Proxy": "http://127.0.0.1:4444"}}}}, "AllowFunnel": map[string]bool{"sol.tail-example.ts.net:443": public}}
			encoded, _ := json.Marshal(config)
			store, _ := json.Marshal(map[string]string{"_machinekey": "a2V5", "_serve/profile": base64.StdEncoding.EncodeToString(encoded)})
			state := filepath.Join(node, "tailscaled.state")
			if err := os.WriteFile(state, store, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(node, "enabled"), []byte("1"), 0600); err != nil {
				t.Fatal(err)
			}
			cli, calls := filepath.Join(dir, "cli"), filepath.Join(dir, "calls")
			writeExecutable(t, cli, `echo "$*" >> "$TS_CALLS"
case "$*" in
 *"serve status --json"*) echo '{}' ;;
 *"status --json"*) echo '{"BackendState":"Running","Self":{"DNSName":"sol.tail-example.ts.net."}}' ;;
esac
`)
			t.Setenv("SOL_TAILSCALE_CLI", cli)
			t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
			t.Setenv("TS_CALLS", calls)
			svc := NewTailscaleService(dir, 8080)
			t.Cleanup(func() { svc.CancelRestore(); svc.waitForRestore() })
			for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
				raw, _ := os.ReadFile(state)
				if !bytes.Contains(raw, []byte("_serve/")) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			raw, _ := os.ReadFile(state)
			if bytes.Contains(raw, []byte("_serve/")) || !bytes.Contains(raw, []byte("_machinekey")) {
				t.Fatal("old target not cleared safely", string(raw))
			}
			if tailscaleFileExists(calls) {
				t.Fatal("daemon resumed before Sol owned its web listener")
			}
			// Simulate shutdown or a failed HTTP bind in this startup window.
			if err := svc.StopForShutdown(); err != nil {
				t.Fatal(err)
			}
			pending, err := os.ReadFile(filepath.Join(node, "restore-serve"))
			wantMode := "private"
			if public {
				wantMode = "public"
			}
			if err != nil || string(pending) != wantMode {
				t.Fatalf("lost selected mode on cancellation: %q %v", pending, err)
			}
			svc = NewTailscaleService(dir, 8080)
			svc.UnixListenerReady("/tmp/test-9090.sock", nil)
			svc.waitForRestore()
			log, _ := os.ReadFile(calls)
			verb := "serve --bg"
			if public {
				verb = "funnel --bg"
			}
			if !strings.Contains(string(log), verb+" --https=443 unix:/tmp/test-9090.sock") || strings.Contains(string(log), "4444") {
				t.Fatalf("restore used wrong mode/target: %s", log)
			}
			if tailscaleFileExists(filepath.Join(node, "restore-serve")) {
				t.Fatal("completed restore retained pending mode")
			}
			if !tailscaleFileExists(filepath.Join(node, "enabled")) {
				t.Fatal("restore disabled valid selected access")
			}
		})
	}
}

func TestTailscaleForgetCancelsRestoreBeforeTheWebListenerIsReady(t *testing.T) {
	dir := t.TempDir()
	node := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(node, 0700); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"enabled": "1", "tailscaled.state": "{}"} {
		if err := os.WriteFile(filepath.Join(node, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	svc := NewTailscaleService(dir, 8080)
	done := make(chan error, 1)
	go func() { _, err := svc.Forget(); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("forget waited forever for an HTTP listener")
	}
	if tailscaleFileExists(filepath.Join(node, "tailscaled.state")) || tailscaleFileExists(filepath.Join(node, "enabled")) {
		t.Fatal("canceled restore retained identity or opt-in")
	}
}

func TestTailscaleStartupRestoreKeepsStatusResponsiveAndSerializesShutdown(t *testing.T) {
	dir := t.TempDir()
	data := filepath.Join(dir, "data")
	node := filepath.Join(data, "tailscale")
	if err := os.MkdirAll(node, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "enabled"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	called, release := filepath.Join(dir, "called"), filepath.Join(dir, "release")
	cli := filepath.Join(dir, "cli")
	writeExecutable(t, cli, "echo called > \"$TS_CALLED\"\nwhile [ ! -f \"$TS_RELEASE\" ]; do sleep 0.05; done\necho '{\"BackendState\":\"Running\"}'\n")
	t.Setenv("SOL_TAILSCALE_CLI", cli)
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	t.Setenv("TS_CALLED", called)
	t.Setenv("TS_RELEASE", release)
	svc := NewTailscaleService(data, 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	t.Cleanup(func() { _ = os.WriteFile(release, nil, 0600); svc.waitForRestore() })
	for deadline := time.Now().Add(time.Second); !tailscaleFileExists(called) && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	if !tailscaleFileExists(called) {
		t.Fatal("restore did not start")
	}
	started := time.Now()
	if st := svc.Status(); st.State != "starting" {
		t.Fatalf("restore status = %#v", st)
	}
	if _, err := svc.Connect(); err == nil {
		t.Fatal("connect overlapped startup restore")
	}
	if time.Since(started) > time.Second {
		t.Fatal("status/connect blocked behind startup")
	}
	done := make(chan error, 1)
	go func() { _, err := svc.Disable(); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("shutdown overlapped restore: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := os.WriteFile(release, nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown did not finish")
	}
	if svc.Status().Enabled {
		t.Fatal("shutdown was lost to startup restore")
	}
}

func TestTailscaleStartupRestoreLogsFailure(t *testing.T) {
	dir := t.TempDir()
	node := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(node, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "enabled"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	svc := NewTailscaleService(dir, 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	svc.waitForRestore()
	if !strings.Contains(logs.String(), "Could not restore Tailscale at startup") {
		t.Fatalf("missing restore diagnostic: %s", logs.String())
	}
}

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0700); err != nil {
		t.Fatal(err)
	}
}

func TestTailscaleCommandTimeoutReturnsPartialApprovalOutput(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	writeExecutable(t, bin, "echo 'https://login.tailscale.com/a/pending'; sleep 10\n")
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	svc := &TailscaleService{dir: filepath.Join(dir, "data")}
	started := time.Now()
	out, err := svc.run("up", "--json")
	if err == nil || !strings.Contains(out, "https://login.tailscale.com/a/pending") {
		t.Fatalf("partial output=%q err=%v", out, err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("hung CLI took %s", time.Since(started))
	}
}

func TestTailscaleStatusIgnoresStderrWarningsAndDoesNotRestart(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	writeExecutable(t, bin, `echo 'harmless warning' >&2
case "$*" in
 *"serve status --json"*) echo '{}' ;;
 *"status --json"*) echo '{"BackendState":"Running"}' ;;
esac
`)
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	svc := &TailscaleService{dir: dir, port: 8080}
	if err := os.WriteFile(filepath.Join(dir, "enabled"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	if st := svc.Status(); st.State != "connected" || st.Error != "" {
		t.Fatalf("warning broke status: %#v", st)
	}
	writeExecutable(t, bin, "exit 1\n")
	if st := svc.Status(); st.State != "error" {
		t.Fatalf("unavailable daemon => %#v", st)
	}
	if tailscaleFileExists(filepath.Join(dir, "tailscaled.pid")) {
		t.Fatal("status polling attempted to start a daemon")
	}
}

func TestTailscaleBrokenCLICanDisableAndForget(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	writeExecutable(t, bin, "exit 1\n")
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("SOL_TAILSCALED", "/bin/bash")
	svc := &TailscaleService{dir: dir, port: 8080}
	state := filepath.Join(dir, "tailscaled.state")
	process := exec.Command("bash", "-c", "while :; do sleep 1; done", "--state", state)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL); _ = process.Wait() }()
	for name, value := range map[string]string{"enabled": "1", "tailscaled.state": "identity", "tailscaled.sock": "", "tailscaled.pid": strconv.Itoa(process.Process.Pid)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for !svc.managedDaemonAlive() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !svc.managedDaemonAlive() {
		t.Fatal("fixture daemon is not ready")
	}
	start, err := tailscaleProcessStart(process.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.writeLaunchIntent(fmt.Sprintf("%d %s %s", process.Process.Pid, start, mustBootID(t)), true); err != nil {
		t.Fatal(err)
	}
	st, err := svc.Disable()
	if err != nil || st.Enabled || !st.IdentitySaved || svc.managedDaemonAlive() {
		t.Fatalf("disable = %#v %v", st, err)
	}
	if !tailscaleFileExists(filepath.Join(dir, "reset-required")) {
		t.Fatal("broken CLI did not preserve reset intent")
	}
	st, err = svc.Forget()
	if err != nil || st.IdentitySaved || st.Enabled {
		t.Fatalf("forget = %#v %v", st, err)
	}
}

func TestTailscaleVerifiedDisableClearsStaleError(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing"))
	svc := &TailscaleService{dir: dir, port: 8080}
	for name, value := range map[string]string{"stop-verified": mustBootID(t), "tailscaled.state": `{}`, "last-error": "old failure"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	status, err := svc.Disable()
	if err != nil || status.Error != "" || status.Enabled {
		t.Fatalf("disable = %#v, %v", status, err)
	}
	if tailscaleFileExists(filepath.Join(dir, "last-error")) {
		t.Fatal("stale error was retained")
	}
}

func TestTailscaleReconnectClearsSavedServeBeforeUp(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	calls := filepath.Join(dir, "calls")
	writeExecutable(t, bin, "echo \"$*\" >> \"$TS_LOG\"\ncase \"$*\" in *'status --json'*) echo '{}' ;; esac\n")
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("TS_LOG", calls)
	svc := &TailscaleService{dir: dir, port: 8080}
	if err := os.WriteFile(filepath.Join(dir, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte(`{"_serve/old":"e30=","_machinekey":"a2V5"}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"reset-required", "enabled"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("1"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Reconnect(); err != nil {
		t.Fatal(err)
	}
	log, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(log), "up --") {
		t.Fatalf("reconnect did not bring up the node: %s", log)
	}
	state, err := os.ReadFile(filepath.Join(dir, "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(state), "_serve/") || !strings.Contains(string(state), "_machinekey") {
		t.Fatalf("saved access cleanup lost identity or kept Serve: %s", state)
	}
}

func TestTailscaleOfflineCleanupPreservesIdentityAndRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	svc := &TailscaleService{dir: dir}
	path := filepath.Join(dir, "tailscaled.state")
	fixture := `{"_machinekey":"a2V5","profile-a":"cHJlZnM=","_serve/a":"e30=","_serve/b":"e30=","future":{"value":42}}`
	if err := os.WriteFile(path, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.clearSavedServe(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["_machinekey"] != "a2V5" || got["profile-a"] != "cHJlZnM=" {
		t.Fatalf("identity was changed: %s", raw)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("identity permissions are not private")
	}
	for _, corrupt := range []string{"broken", "null", "[]"} {
		if err := os.WriteFile(path, []byte(corrupt), 0600); err != nil {
			t.Fatal(err)
		}
		if svc.clearSavedServe() == nil {
			t.Fatalf("accepted corrupt state %q", corrupt)
		}
		after, _ := os.ReadFile(path)
		if string(after) != corrupt {
			t.Fatal("corrupt identity was overwritten")
		}
	}
}

func TestTailscaleTeardownDoesNotKillUnverifiedSocketOwner(t *testing.T) {
	dir, err := os.MkdirTemp("", "ts café \\040 ")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	svc := &TailscaleService{dir: dir}
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
	listener, err := net.Listen("unix", svc.sock())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	for name, value := range map[string]string{"enabled": "1", "tailscaled.pid": strconv.Itoa(os.Getpid()), "tailscaled.state": "{}"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.ensureDaemon(); err == nil || !tailscaleFileExists(svc.sock()) {
		t.Fatal("startup removed a live unverified socket", err)
	}
	st, err := svc.Disable()
	if err != nil || st.Enabled || !st.ResidualExposure || st.State != "error" {
		t.Fatalf("unverified owner => %#v, %v", st, err)
	}
	if _, err := svc.Forget(); err == nil {
		t.Fatal("removed identity while an unverified listener was still live")
	}
	if !tailscaleFileExists(filepath.Join(dir, "tailscaled.state")) {
		t.Fatal("identity was removed")
	}
	if err := os.Remove(svc.sock()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Forget(); err == nil {
		t.Fatal("unlinked live socket lost its ownership evidence")
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Forget(); err == nil {
		t.Fatal("unverified PID must remain uncertain")
	}
}

func TestTailscaleUninstallRefusesUnverifiedListenerWithoutTrustingCLIExit(t *testing.T) {
	dir, err := os.MkdirTemp("", "ts-uninstall-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	node := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(node, 0700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(node, "tailscaled.sock")
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	installer, err := filepath.Abs("../../../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	writeExecutable(t, filepath.Join(dir, "tailscale", "tailscale"), "exit 1\n")
	removed := filepath.Join(dir, "remove-calls")
	// Exercise the real uninstall flow, replacing ALL deletion/systemd/root
	// operations. No system path is mutated by this regression harness.
	run := func() error {
		cmd := exec.Command("bash", "-c", `source "$1"
check_root() { :; }; run_systemctl() { :; }
log_info() { :; }; log_warn() { :; }; log_error() { :; }
rm() { printf '%s\n' "$*" >> "$TS_REMOVALS"; }
DATA_DIR="$2"; TAILSCALE_INSTALL_DIR="$2/tailscale"
do_uninstall`, "check", installer, dir, removed)
		cmd.Env = append(os.Environ(), "TS_REMOVALS="+removed)
		return cmd.Run()
	}
	if err := run(); err == nil {
		t.Fatal("uninstall accepted a live unverified listener")
	}
	if tailscaleFileExists(removed) {
		t.Fatal("uninstall attempted to remove files")
	}
	if err := os.Remove(sock); err != nil {
		t.Fatal(err)
	}
	if err := run(); err == nil {
		t.Fatal("uninstall accepted an unlinked live listener")
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if err := run(); err != nil {
		t.Fatal("stopped listener prevented uninstall", err)
	}
	if !tailscaleFileExists(removed) {
		t.Fatal("uninstall harness never reached its stubbed deletion")
	}
}

func TestTailscaleFailedResetWriteStillClearsEnabledIntent(t *testing.T) {
	dir := t.TempDir()
	svc := &TailscaleService{dir: dir}
	if err := os.WriteFile(filepath.Join(dir, "enabled"), []byte("1"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "reset-required"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Disable(); err == nil {
		t.Fatal("failed persistence was reported as successful")
	}
	if tailscaleFileExists(filepath.Join(dir, "enabled")) {
		t.Fatal("failed reset write preserved automatic restoration intent")
	}
}

func TestPrivateSwitchClearsPublicIntentBeforeUpFailure(t *testing.T) {
	dir := t.TempDir()
	cli := filepath.Join(dir, "cli")
	marker := filepath.Join(dir, "up-reached")
	writeExecutable(t, cli, `case "$*" in
  *"status --json"*) echo '{"BackendState":"Running"}' ;;
  *"up "*) touch "$TS_UP_MARKER"; exit 1 ;;
esac`)
	t.Setenv("SOL_TAILSCALE_CLI", cli)
	t.Setenv("TS_UP_MARKER", marker)
	svc := NewTailscaleService(dir, 8080)
	svc.UnixListenerReady("/tmp/test-private.sock", nil)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	boot, err := tailscaleBootID()
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"enabled": "1", "stop-verified": boot, "restore-serve": "public", "tailscaled.state": `{"_machinekey":"a2V5","_serve/profile":"e30="}`} {
		if err := os.WriteFile(filepath.Join(svc.dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := svc.Serve(false); err == nil {
		t.Fatal("expected mocked up failure")
	}
	if !tailscaleFileExists(marker) {
		t.Fatal("private switch did not reach mocked up")
	}
	if tailscaleFileExists(filepath.Join(svc.dir, "restore-serve")) {
		t.Fatal("public restore intent survived")
	}
	state, err := os.ReadFile(filepath.Join(svc.dir, "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(state), "_serve/") {
		t.Fatal("public Serve configuration survived")
	}
}

func TestTailscaleUsesPrivatePersistentUserspaceNodeAndServe(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	daemon := filepath.Join(dir, "tailscaled-mock")
	log := filepath.Join(dir, "calls")
	ready := filepath.Join(dir, "ready")
	servedMarker := filepath.Join(dir, "served")
	writeExecutable(t, daemon, "echo \"$*\" >> \"$TS_LOG\"\nwhile [ $# -gt 0 ]; do if [ \"$1\" = --socket ] || [ \"$1\" = --state ]; then touch \"$2\"; fi; shift; done\ntouch \"$TS_READY\"\n")
	writeExecutable(t, bin, `echo "$*" >> "$TS_LOG"
	case "$*" in
	  *"serve status --json"*) if [ -f "$TS_SERVED" ]; then echo '{"Web":{"sol.tail-example.ts.net:443":{"Handlers":{"/":{"Proxy":"unix:/tmp/test-8080.sock"}}}},"AllowFunnel":{"sol.tail-example.ts.net:443":false}}'; else echo '{}'; fi ;;
	  *"serve --bg"*) touch "$TS_SERVED" ;;
	  *"status --json"*) [ -f "$TS_READY" ] || exit 1; echo '{"BackendState":"Running","Self":{"DNSName":"sol.tail-example.ts.net."}}' ;;
  *"up "*) echo '{"AuthURL":"https://login.tailscale.com/a/approval"}' ;;
esac
`)
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("SOL_TAILSCALED", daemon)
	t.Setenv("TS_LOG", log)
	t.Setenv("TS_READY", ready)
	t.Setenv("TS_SERVED", servedMarker)
	svc := NewTailscaleService(filepath.Join(dir, "data"), 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	connected, err := svc.Connect()
	if err != nil {
		t.Fatal(err)
	}
	if connected.State != "connected" || connected.PrivateURL != "" {
		t.Fatalf("unexpected connected status: %#v", connected)
	}
	served, err := svc.Serve(false)
	if err != nil || served.PrivateURL != "https://sol.tail-example.ts.net" {
		t.Fatalf("private listener wasn't configured: %#v, %v", served, err)
	}
	calls, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--tun=userspace-networking", "--state", "tailscaled.state", "--https=443", "unix:/tmp/test-8080.sock", "serve --bg"} {
		if !strings.Contains(string(calls), want) {
			t.Errorf("calls missing %q:\n%s", want, calls)
		}
	}
	if st := svc.Status(); !st.Enabled || !st.IdentitySaved || st.State != "connected" {
		t.Fatalf("node state did not persist: %#v", st)
	}
}

func TestTailscaleURLsRequireActualListenerAndFunnelPermission(t *testing.T) {
	fixture := map[string]any{"Web": map[string]any{"sol.tail-example.ts.net:443": map[string]any{"Handlers": map[string]any{"/": map[string]any{"Proxy": "http://127.0.0.1:8080"}}}}, "AllowFunnel": map[string]any{"sol.tail-example.ts.net:443": false}, "Note": "https://attacker.ts.net"}
	public, private := configuredURLs(fixture, "https://sol.tail-example.ts.net", "http://127.0.0.1:8080")
	if public != "" || private != "https://sol.tail-example.ts.net" {
		t.Fatalf("private config => %q %q", public, private)
	}
	fixture["AllowFunnel"] = map[string]any{"sol.tail-example.ts.net:443": true}
	public, private = configuredURLs(fixture, "https://sol.tail-example.ts.net", "http://127.0.0.1:8080")
	if public != "https://sol.tail-example.ts.net" || private != "" {
		t.Fatalf("public config => %q %q", public, private)
	}
	fixture["Web"].(map[string]any)["sol.tail-example.ts.net:443"].(map[string]any)["Handlers"].(map[string]any)["/"].(map[string]any)["Proxy"] = "http://127.0.0.1:9000"
	public, private = configuredURLs(fixture, "https://sol.tail-example.ts.net", "http://127.0.0.1:8080")
	if public != "" || private != "" {
		t.Fatalf("wrong backend was exposed: %q %q", public, private)
	}
	public, private = configuredURLs(map[string]any{"Note": "https://attacker.ts.net"}, "https://sol.tail-example.ts.net", "http://127.0.0.1:8080")
	if public != "" || private != "" {
		t.Fatalf("unconfigured URL leaked: %q %q", public, private)
	}
}

func TestTailscaleDevelopmentScenariosNeverStartARealNode(t *testing.T) {
	t.Setenv("SOL_INSECURE_DEV", "true")
	t.Setenv("SOL_TAILSCALE_SCENARIO", "pending")
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(t.TempDir(), "missing-cli"))
	t.Setenv("SOL_TAILSCALED", filepath.Join(t.TempDir(), "missing-daemon"))
	svc := NewTailscaleService(t.TempDir(), 8080)
	st := svc.Status()
	if st.State != "pending" || st.AuthURL == "" || !st.Enabled {
		t.Fatalf("pending scenario = %#v", st)
	}
	connected, err := svc.Serve(true)
	if err != nil {
		t.Fatal(err)
	}
	if connected.State != "connected" || connected.PublicURL == "" {
		t.Fatalf("public preview = %#v", connected)
	}
	t.Setenv("SOL_TAILSCALE_SCENARIO", "failure")
	failed := NewTailscaleService(t.TempDir(), 8080).Status()
	if failed.State != "error" || failed.Error == "" {
		t.Fatalf("failure scenario = %#v", failed)
	}
}

func TestTailscalePrivateListenerKeepsPendingFunnelApproval(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "tailscale-mock")
	configFile := filepath.Join(dir, "serve.json")
	writeExecutable(t, bin, `case "$*" in
  *"serve status --json"*) cat "$TS_SERVE_CONFIG" ;;
  *"status --json"*) if [ -n "$TS_NEEDS_LOGIN" ]; then echo '{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/test"}'; else echo '{"BackendState":"Running","Self":{"DNSName":"sol.tail-example.ts.net."}}'; fi ;;
esac
`)
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("TS_SERVE_CONFIG", configFile)
	svc := NewTailscaleService(dir, 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"enabled": "1", "approval-type": "funnel", "approval-url": "https://login.tailscale.com/admin/acls"} {
		if err := os.WriteFile(filepath.Join(svc.dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixture := `{"Web":{"sol.tail-example.ts.net:443":{"Handlers":{"/":{"Proxy":"unix:/tmp/test-8080.sock"}}}},"AllowFunnel":{"sol.tail-example.ts.net:443":false}}`
	if err := os.WriteFile(configFile, []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	private := svc.Status()
	if private.PrivateURL == "" || private.PublicURL != "" || private.ApprovalURL == "" || private.ApprovalType != "funnel" {
		t.Fatalf("private listener lost pending public approval: %#v", private)
	}
	if err := os.WriteFile(configFile, []byte(strings.Replace(fixture, ":false", ":true", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	public := svc.Status()
	if public.PublicURL == "" || public.PrivateURL != "" || public.ApprovalURL != "" {
		t.Fatalf("public listener did not complete approval: %#v", public)
	}
	for _, bad := range []string{"invalid json", ""} {
		if err := os.WriteFile(configFile, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		unknown := svc.Status()
		if unknown.State != "error" || !unknown.ResidualExposure || unknown.PublicURL != "" {
			t.Fatalf("unreadable Serve status must report unknown exposure: %#v", unknown)
		}
	}
	if err := os.Remove(configFile); err != nil {
		t.Fatal(err)
	}
	if unknown := svc.Status(); unknown.State != "error" || !unknown.ResidualExposure {
		t.Fatalf("failed Serve command must report unknown exposure: %#v", unknown)
	}
	if err := os.WriteFile(configFile, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if empty := svc.Status(); empty.State != "connected" || empty.ResidualExposure || empty.PublicURL != "" {
		t.Fatalf("verified empty Serve status: %#v", empty)
	}
	if err := os.WriteFile(configFile, []byte(`null`), 0600); err != nil {
		t.Fatal(err)
	}
	if empty := svc.Status(); empty.State != "connected" || empty.ResidualExposure {
		t.Fatalf("null Serve status: %#v", empty)
	}
	t.Setenv("TS_NEEDS_LOGIN", "1")
	if pending := svc.Status(); pending.State != "pending" || pending.AuthURL == "" || pending.ResidualExposure {
		t.Fatalf("null Serve status during login: %#v", pending)
	}
}

func TestTailscaleInstallerRejectsReusedPIDAndWrongState(t *testing.T) {
	installer, err := filepath.Abs("../../../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(t.TempDir(), "tailscaled.state")
	process := exec.Command("bash", "-c", `exec -a tailscaled bash -c 'while :; do sleep 1; done' --state "$1"`, "fixture", state)
	process.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Kill(-process.Process.Pid, syscall.SIGKILL); _ = process.Wait() }()
	check := func(pid int, path string) bool {
		command := exec.Command("bash", "-c", `source "$1"; tailscale_pid_matches "$2" "$3"`, "check", installer, strconv.Itoa(pid), path)
		return command.Run() == nil
	}
	// Allow bash to exec with the fixture's daemon name.
	deadline := time.Now().Add(2 * time.Second)
	for !check(process.Process.Pid, state) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !check(process.Process.Pid, state) {
		t.Fatal("managed fixture was not recognized")
	}
	if check(process.Process.Pid, state+"-different") {
		t.Fatal("wrong state path was accepted")
	}
	if check(os.Getpid(), state) {
		t.Fatal("unrelated reused PID was accepted")
	}
	if check(1, state) || check(-1, state) {
		t.Fatal("unsafe PID was accepted")
	}
}

func TestForgetRepairsInvalidControlAfterVerifiedStop(t *testing.T) {
	dir := t.TempDir()
	svc := NewTailscaleService(dir, 8080)
	node := filepath.Join(dir, "tailscale")
	if err := os.MkdirAll(node, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "control-server"), []byte("http://invalid.example"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(node, "tailscaled.state"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Forget(); err != nil {
		t.Fatal(err)
	}
	if got, err := svc.controlServer(); err != nil || got != "" {
		t.Fatalf("control server %q: %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(node, "tailscaled.state")); !os.IsNotExist(err) {
		t.Fatalf("identity remains: %v", err)
	}
}

func TestPendingDisableNeverRestoresSavedPublicAccess(t *testing.T) {
	dir := t.TempDir()
	node := filepath.Join(dir, "tailscale")
	if err := os.Mkdir(node, 0700); err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"Web": map[string]any{"sol.example.ts.net:443": map[string]any{"Handlers": map[string]any{"/": map[string]string{"Proxy": "http://127.0.0.1:4444"}}}}, "AllowFunnel": map[string]bool{"sol.example.ts.net:443": true}}
	encoded, _ := json.Marshal(config)
	store, _ := json.Marshal(map[string]string{"_machinekey": "a2V5", "_serve/profile": base64.StdEncoding.EncodeToString(encoded)})
	for name, data := range map[string][]byte{"tailscaled.state": store, "enabled": []byte("1"), "reset-required": []byte("1"), "restore-serve": []byte("public")} {
		if err := os.WriteFile(filepath.Join(node, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(node, "stop-verified"), []byte(mustBootID(t)), 0600); err != nil {
		t.Fatal(err)
	}
	cli, calls := filepath.Join(dir, "cli"), filepath.Join(dir, "calls")
	writeExecutable(t, cli, `echo "$*" >> "$TS_CALLS"`)
	t.Setenv("SOL_TAILSCALE_CLI", cli)
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing-daemon"))
	t.Setenv("TS_CALLS", calls)
	svc := NewTailscaleService(dir, 8080)
	svc.UnixListenerReady("/tmp/test-8080.sock", nil)
	svc.waitForRestore()
	if tailscaleFileExists(calls) {
		t.Fatal("pending disable started Tailscale")
	}
	for _, name := range []string{"enabled", "reset-required", "restore-serve"} {
		if tailscaleFileExists(filepath.Join(node, name)) {
			t.Fatalf("%s remains", name)
		}
	}
	raw, err := os.ReadFile(filepath.Join(node, "tailscaled.state"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("_serve/")) || !bytes.Contains(raw, []byte("_machinekey")) {
		t.Fatalf("bad state: %s", raw)
	}
}

func TestIncompleteLaunchNeverCountsAsStoppedOrForgettable(t *testing.T) {
	dir := t.TempDir()
	svc := NewTailscaleService(dir, 8080)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "launch-intent"), []byte("pending"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "tailscaled.state"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.stopDaemon(); err == nil {
		t.Fatal("accepted uncertain launch")
	}
	if _, err := svc.Forget(); err == nil {
		t.Fatal("forgot uncertain identity")
	}
	if _, err := os.Stat(filepath.Join(svc.dir, "tailscaled.state")); err != nil {
		t.Fatal(err)
	}
}

func TestTailscaleStatusAcceptsOnlyCurrentUnixGeneration(t *testing.T) {
	fixture := map[string]any{"Web": map[string]any{"sol.example.ts.net:443": map[string]any{"Handlers": map[string]any{"/": map[string]any{"Proxy": "unix:/private/old/s"}}}}, "AllowFunnel": map[string]any{"sol.example.ts.net:443": true}}
	public, private := configuredURLsForControl(fixture, "https://sol.example.ts.net", "unix:/private/new/s", false)
	if public != "" || private != "" {
		t.Fatal("accepted old generation")
	}
	public, _ = configuredURLsForControl(fixture, "https://sol.example.ts.net", "unix:/private/old/s", false)
	if public == "" {
		t.Fatal("rejected current generation")
	}
}

func TestPidfdStopTargetsVerifiedLiveProcess(t *testing.T) {
	dir := t.TempDir()
	svc := NewTailscaleService(dir, 8080)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOL_TAILSCALED", "/bin/sh")
	cmd := exec.Command("/bin/sh", "-c", "printf ready; read value", "--state", filepath.Join(svc.dir, "tailscaled.state"))
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := make([]byte, 5)
	if _, err := io.ReadFull(output, ready); err != nil || string(ready) != "ready" {
		t.Fatalf("ready: %q %v", ready, err)
	}
	start, err := tailscaleProcessStart(cmd.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.writeLaunchIntent(fmt.Sprintf("%d %s %s", cmd.Process.Pid, start, mustBootID(t)), true); err != nil {
		t.Fatal(err)
	}
	if err := svc.stopDaemon(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(svc.dir, "launch-intent")); !os.IsNotExist(err) {
		t.Fatalf("intent remains: %v", err)
	}
}

func mustBootID(t *testing.T) string {
	t.Helper()
	value, err := tailscaleBootID()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestPendingLaunchFromPriorBootIsRetired(t *testing.T) {
	dir := t.TempDir()
	svc := NewTailscaleService(dir, 8080)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "launch-intent"), []byte("pending 00000000-0000-0000-0000-000000000000"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "tailscaled.state"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.stopDaemon(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(svc.dir, "launch-intent")); !os.IsNotExist(err) {
		t.Fatalf("intent remains: %v", err)
	}
	proof, err := os.ReadFile(filepath.Join(svc.dir, "stop-verified"))
	if err != nil || string(proof) != mustBootID(t) {
		t.Fatalf("proof %q %v", proof, err)
	}
}

func TestVerifiedStopProofSurvivesRebootAndMissingDaemon(t *testing.T) {
	dir := t.TempDir()
	svc := NewTailscaleService(dir, 8080)
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "tailscaled.state"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dir, "stop-verified"), []byte("00000000-0000-0000-0000-000000000000"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := svc.stopDaemon(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SOL_TAILSCALED", filepath.Join(dir, "missing"))
	t.Setenv("SOL_TAILSCALE_CLI", filepath.Join(dir, "missing-cli"))
	if err := svc.ensureDaemon(); err == nil {
		t.Fatal("missing daemon started")
	}
	if !svc.validStopProof() || tailscaleFileExists(filepath.Join(svc.dir, "launch-intent")) {
		t.Fatal("failed spawn lost proof")
	}
	if _, err := svc.Forget(); err != nil {
		t.Fatal(err)
	}
}

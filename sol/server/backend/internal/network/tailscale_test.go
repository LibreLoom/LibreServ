package network

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

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
	  *"funnel status --json"*) if [ -f "$TS_SERVED" ]; then echo '{"Web":{"sol.tail-example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080"}}}},"AllowFunnel":{"sol.tail-example.ts.net:443":false}}'; else echo '{}'; fi ;;
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
	for _, want := range []string{"--tun=userspace-networking", "--state", "tailscaled.state", "--https=443", "http://127.0.0.1:8080", "serve --bg"} {
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
  *"funnel status --json"*) cat "$TS_SERVE_CONFIG" ;;
  *"status --json"*) echo '{"BackendState":"Running","Self":{"DNSName":"sol.tail-example.ts.net."}}' ;;
esac
`)
	t.Setenv("SOL_TAILSCALE_CLI", bin)
	t.Setenv("TS_SERVE_CONFIG", configFile)
	svc := &TailscaleService{dir: filepath.Join(dir, "state"), port: 8080}
	if err := os.MkdirAll(svc.dir, 0700); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"enabled": "1", "approval-type": "funnel", "approval-url": "https://login.tailscale.com/admin/acls"} {
		if err := os.WriteFile(filepath.Join(svc.dir, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	fixture := `{"Web":{"sol.tail-example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080"}}}},"AllowFunnel":{"sol.tail-example.ts.net:443":false}}`
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

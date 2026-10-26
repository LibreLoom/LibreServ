package network

// TailscaleService owns one persistent product node. It deliberately exposes
// only the product web server through Serve/Funnel, never app TCP or UDP ports.
import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const TailscaleVersion = "1.104.2"

type TailscaleStatus struct {
	Installed        bool   `json:"installed"`
	Enabled          bool   `json:"enabled"`
	IdentitySaved    bool   `json:"identity_saved"`
	State            string `json:"state"`
	PrivateURL       string `json:"private_url"`
	PublicURL        string `json:"public_url"`
	AuthURL          string `json:"auth_url"`
	ApprovalURL      string `json:"approval_url"`
	ApprovalType     string `json:"approval_type"`
	Error            string `json:"error"`
	ResidualExposure bool   `json:"residual_exposure"`
}

type TailscaleService struct {
	dir           string
	port          int
	mu            sync.Mutex
	mockMu        sync.Mutex
	devScenario   string
	devPublic     bool
	restoreDone   chan struct{}
	listenerReady chan struct{}
	listenerOnce  sync.Once
	listenerError error
	listenerPort  int
	restoreCancel chan struct{}
	cancelOnce    sync.Once
	shuttingDown  bool // protected by mu; forbids restarting after shutdown
}

func NewTailscaleService(dataDir string, port int) *TailscaleService {
	s := &TailscaleService{dir: filepath.Join(dataDir, "tailscale"), port: port,
		listenerReady: make(chan struct{}), restoreCancel: make(chan struct{})}
	if strings.EqualFold(os.Getenv("SOL_INSECURE_DEV"), "true") {
		s.devScenario = os.Getenv("SOL_TAILSCALE_SCENARIO")
	}
	if s.devScenario == "" && tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		// Gate mutations until this bounded restore finishes, without holding
		// the status mutex through daemon readiness. Status remains readable.
		s.restoreDone = make(chan struct{})
		go func() {
			defer close(s.restoreDone)
			err := s.restoreForWebListener()
			if err != nil {
				slog.Warn("Could not restore Tailscale at startup", "error", err)
				st, offErr := s.disableLocked()
				if offErr != nil {
					slog.Warn("Could not persist Tailscale shutdown after restore failure", "error", offErr)
				}
				if !st.ResidualExposure {
					_ = os.WriteFile(filepath.Join(s.dir, "last-error"), []byte("Tailscale could not restore remote access. Try connecting again."), 0600)
				}
			}
		}()
	}
	return s
}

// WebListenerReady is called by Sol only after net.Listen succeeds. Never
// resume a saved public proxy against an unbound or different process's port.
func (s *TailscaleService) WebListenerReady(addr net.Addr) {
	s.listenerOnce.Do(func() {
		tcp, ok := addr.(*net.TCPAddr)
		if !ok || tcp.Port <= 0 || (!tcp.IP.IsUnspecified() && !tcp.IP.Equal(net.IPv4(127, 0, 0, 1))) {
			s.listenerError = errors.New("Tailscale needs Sol's IPv4 loopback web listener")
		} else {
			s.listenerPort = tcp.Port
		}
		close(s.listenerReady)
	})
}

func (s *TailscaleService) webPort() int {
	if s.listenerReady != nil {
		select {
		case <-s.listenerReady:
			return s.listenerPort
		default:
		}
	}
	return s.port
}

func (s *TailscaleService) CancelRestore() {
	if s.restoreCancel != nil {
		s.cancelOnce.Do(func() { close(s.restoreCancel) })
	}
}

func (s *TailscaleService) requireWebListener() error {
	if s.listenerReady == nil || s.devScenario != "" {
		return nil
	}
	select {
	case <-s.listenerReady:
	default:
		return errors.New("Sol's web listener is not ready")
	}
	return s.listenerError
}

// StopForShutdown preserves the selected mode and opt-in for the next boot,
// but never leaves a managed public proxy forwarding after Sol releases HTTP.
func (s *TailscaleService) StopForShutdown() error {
	s.CancelRestore()
	s.waitForRestore()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.shuttingDown = true
	if s.devScenario != "" {
		return nil
	}
	return s.stopDaemon()
}

func (s *TailscaleService) restoreForWebListener() error {
	mode, err := s.savedServeMode()
	if err != nil {
		return err
	}
	if err := s.stopDaemon(); err != nil {
		return err
	}
	// Retain Admin intent across a failed bind or interrupted startup, before
	// deleting the old proxy target. Never persist the old target itself.
	if mode != "" {
		if err := os.WriteFile(filepath.Join(s.dir, "restore-serve"), []byte(mode), 0600); err != nil {
			return err
		}
	}
	if err := s.clearSavedServe(); err != nil {
		return err
	}
	select {
	case <-s.restoreCancel:
		return nil
	case <-s.listenerReady:
	}
	if s.listenerError != nil {
		return s.listenerError
	}
	if err := s.ensureDaemon(); err != nil {
		return err
	}
	if mode != "" {
		_, err = s.serveLocked(mode == "public")
	}
	if err == nil {
		err = removeTailscalePendingMode(s.dir)
	}
	return err
}

func removeTailscalePendingMode(dir string) error {
	err := os.Remove(filepath.Join(dir, "restore-serve"))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Infer the selected mode from the pinned FileStore before clearing its old
// targets. Only one saved profile may restore managed web access automatically.
func (s *TailscaleService) savedServeMode() (string, error) {
	if pending, err := os.ReadFile(filepath.Join(s.dir, "restore-serve")); err == nil {
		if string(pending) != "private" && string(pending) != "public" {
			return "", errors.New("invalid saved Tailscale access mode")
		}
		return string(pending), nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "tailscaled.state"))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return "", nil
	}
	var store map[string]json.RawMessage
	if err := json.Unmarshal(raw, &store); err != nil {
		return "", err
	}
	mode := ""
	for key, value := range store {
		if !strings.HasPrefix(key, "_serve/") {
			continue
		}
		var encoded string
		if err := json.Unmarshal(value, &encoded); err != nil {
			return "", err
		}
		config, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return "", err
		}
		var saved struct {
			Web         map[string]json.RawMessage
			AllowFunnel map[string]bool
		}
		if err := json.Unmarshal(config, &saved); err != nil {
			return "", err
		}
		if len(saved.Web) == 0 {
			continue
		}
		if mode != "" {
			return "", errors.New("Tailscale has multiple saved web profiles; reconnect before enabling access")
		}
		mode = "private"
		for listener := range saved.Web {
			if saved.AllowFunnel[listener] {
				mode = "public"
			}
		}
	}
	return mode, nil
}

func (s *TailscaleService) restoring() bool {
	if s.restoreDone == nil {
		return false
	}
	select {
	case <-s.restoreDone:
		return false
	default:
		return true
	}
}

func (s *TailscaleService) waitForRestore() {
	if s.restoreDone != nil {
		<-s.restoreDone
	}
}
func (s *TailscaleService) cli() string {
	if v := os.Getenv("SOL_TAILSCALE_CLI"); v != "" {
		return v
	}
	productBinary := "/usr/local/lib/sol/tailscale/" + TailscaleVersion + "/tailscale"
	if tailscaleFileExists(productBinary) {
		return productBinary
	}
	return "tailscale"
}
func (s *TailscaleService) daemon() string {
	if v := os.Getenv("SOL_TAILSCALED"); v != "" {
		return v
	}
	productBinary := "/usr/local/lib/sol/tailscale/" + TailscaleVersion + "/tailscaled"
	if tailscaleFileExists(productBinary) {
		return productBinary
	}
	return "tailscaled"
}
func (s *TailscaleService) sock() string { return filepath.Join(s.dir, "tailscaled.sock") }
func (s *TailscaleService) managedDaemonPID() (int, bool) {
	b, err := os.ReadFile(filepath.Join(s.dir, "tailscaled.pid"))
	if err != nil {
		return 0, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 {
		return 0, false
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return 0, false
	}
	parts := strings.Split(string(cmdline), "\x00")
	if len(parts) == 0 || filepath.Base(parts[0]) != filepath.Base(s.daemon()) {
		return 0, false
	}
	for i, part := range parts {
		if part == "--state="+filepath.Join(s.dir, "tailscaled.state") || (part == "--state" && i+1 < len(parts) && parts[i+1] == filepath.Join(s.dir, "tailscaled.state")) {
			return pid, true
		}
	}
	return 0, false
}
func (s *TailscaleService) managedDaemonAlive() bool {
	_, alive := s.managedDaemonPID()
	return alive
}
func (s *TailscaleService) run(args ...string) (string, error) {
	all := append([]string{"--socket", s.sock()}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.cli(), all...)
	cmd.WaitDelay = 250 * time.Millisecond
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(string(out) + " " + stderr.String())
		if message == "" {
			message = err.Error()
		}
		if ctx.Err() != nil {
			message = strings.TrimSpace(message + " " + ctx.Err().Error())
		}
		return message, errors.New(message)
	}
	if stderr.Len() > 0 {
		slog.Warn("Tailscale command warning", "command", args[0], "detail", strings.TrimSpace(stderr.String()))
	}
	return string(out), nil
}

// clearSavedServe is only called with the managed daemon stopped. The pinned
// upstream file store is a JSON map; _serve/<profile> holds Serve/Funnel config.
// Preserve every identity/preferences value verbatim, including unknown keys.
// https://github.com/tailscale/tailscale/blob/v1.104.2/ipn/serve.go
func (s *TailscaleService) clearSavedServe() error {
	path := filepath.Join(s.dir, "tailscaled.state")
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) || (err == nil && len(raw) == 0) {
		return nil
	}
	if err != nil {
		return err
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return errors.New("Tailscale is off. Remove its saved identity before connecting again")
	}
	if len(values) == 3 && values["key"] != nil && values["nonce"] != nil && values["data"] != nil {
		return errors.New("Tailscale's encrypted state cannot be cleared offline")
	}
	changed := false
	for key := range values {
		if strings.HasPrefix(key, "_serve/") {
			delete(values, key)
			changed = true
		}
	}
	if !changed {
		return nil
	}
	updated, err := json.Marshal(values)
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.dir, ".tailscale-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(updated); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), path)
}

func (s *TailscaleService) clearAccessIfRequired() error {
	if !tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
		return nil
	}
	if err := s.stopDaemon(); err != nil {
		return err
	}
	if err := s.clearSavedServe(); err != nil {
		return err
	}
	if err := removeTailscalePendingMode(s.dir); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(s.dir, "reset-required")); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(s.dir, "last-error"))
	_ = os.Remove(filepath.Join(s.dir, "stop-failed"))
	return nil
}
func (s *TailscaleService) ensureDaemon() error {
	if s.shuttingDown {
		return errors.New("Sol is shutting down")
	}
	if err := s.clearAccessIfRequired(); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	if _, err := s.run("status", "--json"); err == nil {
		_ = os.Chmod(s.sock(), 0600)
		return nil
	}
	if s.managedDaemonAlive() {
		return fmt.Errorf("Tailscale is starting but not responding yet")
	}
	if err := s.verifySocketStopped(); err != nil {
		return err
	}
	if err := os.Remove(s.sock()); err != nil && !os.IsNotExist(err) {
		return err
	}
	cmd := exec.Command(s.daemon(), "--state", filepath.Join(s.dir, "tailscaled.state"), "--socket", s.sock(), "--tun=userspace-networking")
	cmd.Stdin = nil
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start Tailscale: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	if err := os.WriteFile(filepath.Join(s.dir, "tailscaled.pid"), []byte(fmt.Sprint(cmd.Process.Pid)), 0600); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if _, err := s.run("status", "--json"); err == nil {
			_ = os.Chmod(s.sock(), 0600)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	return fmt.Errorf("Tailscale did not start")
}
func (s *TailscaleService) Status() TailscaleStatus {
	if s.restoring() {
		return TailscaleStatus{Installed: commandExists(s.cli()) && commandExists(s.daemon()), Enabled: true,
			IdentitySaved: tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")), State: "starting"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *TailscaleService) statusLocked() TailscaleStatus {
	s.mockMu.Lock()
	if s.devScenario != "" {
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st
	}
	s.mockMu.Unlock()
	st := TailscaleStatus{Installed: commandExists(s.cli()) && commandExists(s.daemon()), Enabled: tailscaleFileExists(filepath.Join(s.dir, "enabled")), IdentitySaved: tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")), State: "off"}
	if warning, err := os.ReadFile(filepath.Join(s.dir, "last-error")); err == nil {
		st.Error = strings.TrimSpace(string(warning))
	}
	if tailscaleFileExists(filepath.Join(s.dir, "stop-failed")) {
		st.State, st.ResidualExposure = "error", true
		return st
	}
	if b, e := os.ReadFile(filepath.Join(s.dir, "approval-url")); e == nil {
		st.ApprovalURL = strings.TrimSpace(string(b))
		if kind, e := os.ReadFile(filepath.Join(s.dir, "approval-type")); e == nil {
			st.ApprovalType = strings.TrimSpace(string(kind))
		}
	}
	if !st.Enabled {
		return st
	}
	raw, err := s.run("status", "--json")
	if err != nil {
		st.State = "error"
		st.Error = "Tailscale could not read its connection status. Try reconnecting."
		return st
	}
	var data map[string]any
	if json.Unmarshal([]byte(raw), &data) != nil {
		st.State = "error"
		st.Error = "Tailscale returned an unreadable status."
		return st
	}
	backend, _ := data["BackendState"].(string)
	switch backend {
	case "Running":
		st.State = "connected"
	case "NeedsLogin", "NeedsMachineAuth":
		st.State = "pending"
	default:
		st.State = "disconnected"
	}
	var nodeURL string
	if self, ok := data["Self"].(map[string]any); ok {
		if dns, _ := self["DNSName"].(string); dns != "" {
			nodeURL = "https://" + strings.TrimSuffix(dns, ".")
		}
	}
	if backend == "NeedsMachineAuth" {
		st.AuthURL = "https://login.tailscale.com/admin/machines"
	} else if backend == "NeedsLogin" {
		st.AuthURL, _ = data["AuthURL"].(string)
		if st.AuthURL != "" {
			_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(st.AuthURL), 0600)
		}
	} else {
		_ = os.Remove(filepath.Join(s.dir, "auth-url"))
	}
	var serveConfig any
	if raw, err = s.run("serve", "status", "--json"); err == nil {
		if json.Unmarshal([]byte(raw), &serveConfig) == nil {
			st.PublicURL, st.PrivateURL = configuredURLs(serveConfig, nodeURL, fmt.Sprintf("http://127.0.0.1:%d", s.webPort()))
			if st.State == "connected" && ((st.ApprovalType == "funnel" && st.PublicURL != "") || (st.ApprovalType == "https" && st.PrivateURL != "")) {
				st.ApprovalURL, st.ApprovalType = "", ""
				_ = os.Remove(filepath.Join(s.dir, "approval-url"))
				_ = os.Remove(filepath.Join(s.dir, "approval-type"))
			}
		}
	}
	if st.State != "connected" {
		st.PublicURL, st.PrivateURL = "", ""
	}
	return st
}

func (s *TailscaleService) mockStatusLocked() TailscaleStatus {
	st := TailscaleStatus{Installed: true, State: s.devScenario, IdentitySaved: s.devScenario != "off"}
	switch s.devScenario {
	case "off":
		st.State = "off"
	case "pending":
		st.Enabled = true
		st.State = "pending"
		st.AuthURL = "https://login.tailscale.com/a/dev-preview"
	case "failure":
		st.Enabled = true
		st.State = "error"
		st.Error = "The development Tailscale service is unavailable."
	case "connected", "served", "funnel", "approval":
		st.Enabled = true
		st.State = "connected"
		if s.devScenario != "connected" {
			st.PrivateURL = "https://sol-dev.tail-demo.ts.net"
		}
		if s.devScenario == "funnel" || s.devPublic {
			st.PublicURL = "https://sol-dev.tail-demo.ts.net"
		}
		if s.devScenario == "approval" {
			st.ApprovalURL = "https://login.tailscale.com/admin/acls"
			st.ApprovalType = "funnel"
		}
	default:
		st.State = "error"
		st.Error = "Unknown development Tailscale scenario."
	}
	return st
}

// Serve and Funnel share this JSON configuration. Only a matching Web listener
// is a URL, and only AllowFunnel=true makes that listener public.
func configuredURLs(v any, privateURL, expectedProxy string) (publicURL, private string) {
	root, _ := v.(map[string]any)
	web, _ := root["Web"].(map[string]any)
	allow, _ := root["AllowFunnel"].(map[string]any)
	node, _ := url.Parse(privateURL)
	if node == nil || node.Hostname() == "" {
		return "", ""
	}
	for listener := range web {
		host := strings.TrimSuffix(listener, ":443")
		u, err := url.Parse("https://" + host)
		if err != nil || u.Hostname() == "" || !strings.EqualFold(u.Hostname(), node.Hostname()) || !strings.HasSuffix(strings.ToLower(u.Hostname()), ".ts.net") {
			continue
		}
		entry, _ := web[listener].(map[string]any)
		handlers, _ := entry["Handlers"].(map[string]any)
		configured := false
		for _, raw := range handlers {
			h, _ := raw.(map[string]any)
			if h["Proxy"] == expectedProxy {
				configured = true
				break
			}
		}
		if !configured {
			continue
		}
		if allow[listener] == true {
			return u.String(), ""
		}
		return "", privateURL
	}
	return "", ""
}
func commandExists(name string) bool {
	if strings.ContainsRune(name, filepath.Separator) {
		_, err := os.Stat(name)
		return err == nil
	}
	_, err := exec.LookPath(name)
	return err == nil
}
func tailscaleFileExists(path string) bool { _, err := os.Stat(path); return err == nil }
func (s *TailscaleService) up() error {
	raw, err := s.run("up", "--accept-dns=false", "--json", "--timeout=2s")
	if err != nil {
		var v map[string]any
		rawErr := err.Error()
		start, end := strings.Index(rawErr, "{"), strings.LastIndex(rawErr, "}")
		if start >= 0 && end >= start && json.Unmarshal([]byte(rawErr[start:end+1]), &v) == nil {
			if auth, ok := v["AuthURL"].(string); ok && auth != "" {
				_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(auth), 0600)
				_ = os.Remove(filepath.Join(s.dir, "last-error"))
				return nil
			}
		}
		return err
	}
	var v map[string]any
	if json.Unmarshal([]byte(raw), &v) == nil {
		if auth, ok := v["AuthURL"].(string); ok && auth != "" {
			_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(auth), 0600)
		}
	}
	_ = os.Remove(filepath.Join(s.dir, "last-error"))
	return nil
}
func (s *TailscaleService) Connect() (TailscaleStatus, error) {
	if s.restoring() {
		return TailscaleStatus{}, errors.New("Tailscale is starting. Try connecting again shortly")
	}
	if err := s.requireWebListener(); err != nil {
		return TailscaleStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shuttingDown {
		return TailscaleStatus{}, errors.New("Sol is shutting down")
	}
	if s.devScenario != "" {
		s.mockMu.Lock()
		if s.devScenario == "off" {
			s.devScenario = "pending"
		}
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if err := s.ensureDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	if err := os.WriteFile(filepath.Join(s.dir, "enabled"), []byte("1"), 0600); err != nil {
		return TailscaleStatus{}, err
	}
	if err := s.up(); err != nil {
		return TailscaleStatus{}, err
	}
	return s.statusLocked(), nil
}
func (s *TailscaleService) Reconnect() (TailscaleStatus, error) {
	if s.restoring() {
		return TailscaleStatus{}, errors.New("Tailscale is starting. Try reconnecting again shortly")
	}
	if err := s.requireWebListener(); err != nil {
		return TailscaleStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.shuttingDown {
		return TailscaleStatus{}, errors.New("Sol is shutting down")
	}
	if s.devScenario != "" {
		s.mockMu.Lock()
		if s.devScenario == "off" {
			s.devScenario = "pending"
		}
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if !tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		return TailscaleStatus{}, fmt.Errorf("connect Tailscale first")
	}
	_ = os.Remove(filepath.Join(s.dir, "approval-url"))
	_ = os.Remove(filepath.Join(s.dir, "approval-type"))
	if err := s.stopDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	_ = os.Remove(filepath.Join(s.dir, "stop-failed"))
	if err := s.ensureDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	if err := s.up(); err != nil {
		return TailscaleStatus{}, err
	}
	return s.statusLocked(), nil
}
func approvalURL(raw string) string {
	for _, part := range strings.Fields(raw) {
		part = strings.Trim(part, ".,);]")
		u, err := url.Parse(part)
		if err == nil && u.Scheme == "https" && (u.Hostname() == "tailscale.com" || strings.HasSuffix(u.Hostname(), ".tailscale.com")) {
			return u.String()
		}
	}
	return ""
}
func (s *TailscaleService) Serve(public bool) (TailscaleStatus, error) {
	if s.restoring() {
		return TailscaleStatus{}, errors.New("Tailscale is starting. Try turning on access again shortly")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.serveLocked(public)
}

func (s *TailscaleService) serveLocked(public bool) (TailscaleStatus, error) {
	if s.shuttingDown {
		return TailscaleStatus{}, errors.New("Sol is shutting down")
	}
	if err := s.requireWebListener(); err != nil {
		return TailscaleStatus{}, err
	}
	if s.devScenario != "" {
		s.mockMu.Lock()
		if s.devScenario == "off" {
			s.mockMu.Unlock()
			return TailscaleStatus{}, fmt.Errorf("connect Tailscale first")
		}
		if public {
			s.devScenario = "funnel"
		} else {
			s.devScenario = "served"
		}
		s.devPublic = public
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if err := s.ensureDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	if !tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		return TailscaleStatus{}, fmt.Errorf("connect Tailscale first")
	}
	if err := s.up(); err != nil {
		return TailscaleStatus{}, err
	}
	target := fmt.Sprintf("http://127.0.0.1:%d", s.webPort())
	var out string
	var err error
	if public {
		out, err = s.run("funnel", "--bg", "--https=443", target)
	} else {
		if _, err := s.run("serve", "reset"); err != nil {
			return TailscaleStatus{}, err
		}
		out, err = s.run("serve", "--bg", "--https=443", target)
	}
	if err != nil {
		if u := approvalURL(err.Error()); u != "" {
			_ = os.WriteFile(filepath.Join(s.dir, "approval-url"), []byte(u), 0600)
			_ = os.WriteFile(filepath.Join(s.dir, "approval-type"), []byte(map[bool]string{true: "funnel", false: "https"}[public]), 0600)
			return s.statusLocked(), nil
		}
		return TailscaleStatus{}, err
	}
	if u := approvalURL(out); u != "" {
		_ = os.WriteFile(filepath.Join(s.dir, "approval-url"), []byte(u), 0600)
		_ = os.WriteFile(filepath.Join(s.dir, "approval-type"), []byte(map[bool]string{true: "funnel", false: "https"}[public]), 0600)
	} else {
		_ = os.Remove(filepath.Join(s.dir, "approval-url"))
		_ = os.Remove(filepath.Join(s.dir, "approval-type"))
	}
	return s.statusLocked(), nil
}
func (s *TailscaleService) Disable() (TailscaleStatus, error) {
	s.CancelRestore()
	s.waitForRestore()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.disableLocked()
}

// StopServe removes web access while keeping the node connected to Tailscale.
func (s *TailscaleService) StopServe() (TailscaleStatus, error) {
	s.CancelRestore()
	s.waitForRestore()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.devScenario != "" {
		s.devScenario, s.devPublic = "connected", false
		return s.mockStatusLocked(), nil
	}
	if err := removeTailscalePendingMode(s.dir); err != nil {
		return TailscaleStatus{}, err
	}
	if _, err := s.run("serve", "reset"); err != nil {
		return TailscaleStatus{}, err
	}
	for _, name := range []string{"approval-url", "approval-type"} {
		_ = os.Remove(filepath.Join(s.dir, name))
	}
	return s.statusLocked(), nil
}

func (s *TailscaleService) disableLocked() (TailscaleStatus, error) {
	if s.devScenario != "" {
		s.mockMu.Lock()
		s.devScenario, s.devPublic = "off", false
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if !tailscaleFileExists(s.dir) {
		return s.statusLocked(), nil
	}
	// Persist intent first. A broken CLI must not prevent off or resurrect
	// a saved public listener on the next connection.
	persistErr := os.WriteFile(filepath.Join(s.dir, "reset-required"), []byte("1"), 0600)
	if err := os.Remove(filepath.Join(s.dir, "enabled")); err != nil && !os.IsNotExist(err) {
		persistErr = errors.Join(persistErr, err)
	}
	if tailscaleFileExists(s.sock()) {
		if _, err := s.run("down"); err != nil {
			slog.Warn("Could not disconnect Tailscale through its local API; stopping the managed daemon", "error", err)
		}
	}
	if err := s.stopDaemon(); err != nil {
		slog.Error("Could not verify Tailscale stopped", "error", err)
		message := "Tailscale may still be reachable. Restart Sol before removing its saved identity."
		_ = os.WriteFile(filepath.Join(s.dir, "last-error"), []byte(message), 0600)
		_ = os.WriteFile(filepath.Join(s.dir, "stop-failed"), []byte("1"), 0600)
		st := s.statusLocked()
		st.State, st.Error, st.ResidualExposure = "error", message, true
		return st, nil
	}
	if persistErr != nil {
		return TailscaleStatus{}, persistErr
	}
	for _, name := range []string{"private-enabled", "approval-type", "auth-url", "approval-url"} {
		_ = os.Remove(filepath.Join(s.dir, name))
	}
	if err := s.clearAccessIfRequired(); err != nil {
		slog.Warn("Tailscale is stopped but its saved access could not be cleared", "error", err)
		_ = os.WriteFile(filepath.Join(s.dir, "last-error"), []byte("Tailscale is off. Remove its saved identity before connecting again."), 0600)
	}
	return s.statusLocked(), nil
}

func (s *TailscaleService) stopDaemon() error {
	pid, alive := s.managedDaemonPID()
	if !alive {
		return s.verifySocketStopped()
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && s.managedDaemonAlive() {
		return err
	}
	for i := 0; i < 40; i++ {
		if !s.managedDaemonAlive() {
			if err := s.verifySocketStopped(); err == nil {
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("Tailscale did not stop; its saved identity was kept")
}

func (s *TailscaleService) verifySocketStopped() error {
	entries, err := os.ReadFile("/proc/net/unix")
	if err != nil {
		return fmt.Errorf("could not verify the Tailscale socket stopped: %w", err)
	}
	for _, line := range strings.Split(string(entries), "\n") {
		fields := strings.Fields(line)
		// The path is the remainder after the seven fixed columns and may
		// itself contain spaces. A conservative suffix match fails closed.
		if len(fields) >= 8 && strings.HasSuffix(line, " "+s.sock()) && fields[3] == "00010000" {
			return errors.New("Tailscale's socket is held by a process whose ownership could not be verified")
		}
	}
	return nil
}

func (s *TailscaleService) Forget() (TailscaleStatus, error) {
	s.CancelRestore()
	s.waitForRestore()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.devScenario != "" {
		s.mockMu.Lock()
		s.devScenario, s.devPublic = "off", false
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	st, err := s.disableLocked()
	if st.ResidualExposure {
		return st, errors.New(st.Error)
	}
	// A failed intent-marker write must not prevent forgetting an identity
	// after a separately verified stop. Never erase a live listener's state.
	if stopErr := s.stopDaemon(); stopErr != nil {
		return st, stopErr
	}
	if err != nil {
		slog.Warn("Could not persist Tailscale shutdown intent; removing identity after verified stop", "error", err)
	}
	for _, name := range []string{"tailscaled.state", "enabled"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			return TailscaleStatus{}, err
		}
	}
	for _, name := range []string{"tailscaled.pid", "tailscaled.sock", "restore-serve", "reset-required", "last-error", "stop-failed", "private-enabled", "approval-type", "approval-url", "auth-url"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			slog.Warn("Could not remove old Tailscale metadata after verified stop and identity removal", "file", name, "error", err)
		}
	}
	return s.statusLocked(), nil
}

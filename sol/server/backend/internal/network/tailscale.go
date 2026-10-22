package network

// TailscaleService owns one persistent product node. It deliberately exposes
// only the product web server through Serve/Funnel, never app TCP or UDP ports.
import (
	"context"
	"encoding/json"
	"fmt"
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
	Installed       bool   `json:"installed"`
	Enabled         bool   `json:"enabled"`
	IdentitySaved   bool   `json:"identity_saved"`
	State           string `json:"state"`
	PrivateURL      string `json:"private_url"`
	PublicURL       string `json:"public_url"`
	AuthURL         string `json:"auth_url"`
	ApprovalURL     string `json:"approval_url"`
	ApprovalType    string `json:"approval_type"`
	Error           string `json:"error"`
	Version         string `json:"version"`
	PublicSupported bool   `json:"public_supported"`
}

type TailscaleService struct {
	dir         string
	port        int
	mu          sync.Mutex
	mockMu      sync.Mutex
	devScenario string
	devPublic   bool
}

func NewTailscaleService(dataDir string, port int) *TailscaleService {
	s := &TailscaleService{dir: filepath.Join(dataDir, "tailscale"), port: port}
	if strings.EqualFold(os.Getenv("SOL_INSECURE_DEV"), "true") {
		s.devScenario = os.Getenv("SOL_TAILSCALE_SCENARIO")
	}
	if s.devScenario == "" && tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		go func() { s.mu.Lock(); defer s.mu.Unlock(); _ = s.ensureDaemon() }()
	}
	return s
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
func (s *TailscaleService) managedDaemonAlive() bool {
	b, err := os.ReadFile(filepath.Join(s.dir, "tailscaled.pid"))
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 1 {
		return false
	}
	cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	parts := strings.Split(string(cmdline), "\x00")
	return len(parts) > 0 && filepath.Base(parts[0]) == filepath.Base(s.daemon()) && strings.Contains(string(cmdline), filepath.Join(s.dir, "tailscaled.state"))
}
func (s *TailscaleService) run(args ...string) (string, error) {
	all := append([]string{"--socket", s.sock()}, args...)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.cli(), all...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if ctx.Err() != nil {
			message = strings.TrimSpace(message + " " + ctx.Err().Error())
		}
		return message, fmt.Errorf("%s", message)
	}
	return string(out), nil
}
func (s *TailscaleService) ensureDaemon() error {
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	if _, err := s.run("status", "--json"); err == nil {
		_ = os.Chmod(s.sock(), 0600)
		return nil
	}
	if _, err := os.Stat(s.sock()); err == nil {
		if s.managedDaemonAlive() {
			return fmt.Errorf("Tailscale is starting but not responding yet")
		}
		if err := os.Remove(s.sock()); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	cmd := exec.Command(s.daemon(), "--state", filepath.Join(s.dir, "tailscaled.state"), "--socket", s.sock(), "--tun=userspace-networking")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start Tailscale: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	_ = os.WriteFile(filepath.Join(s.dir, "tailscaled.pid"), []byte(fmt.Sprint(cmd.Process.Pid)), 0600)
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
	st := TailscaleStatus{Installed: commandExists(s.cli()), Enabled: tailscaleFileExists(filepath.Join(s.dir, "enabled")), IdentitySaved: tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")), State: "off", Version: TailscaleVersion, PublicSupported: true}
	if b, e := os.ReadFile(filepath.Join(s.dir, "approval-url")); e == nil {
		st.ApprovalURL = strings.TrimSpace(string(b))
		if kind, e := os.ReadFile(filepath.Join(s.dir, "approval-type")); e == nil {
			st.ApprovalType = strings.TrimSpace(string(kind))
		}
	}
	if !st.Enabled {
		return st
	}
	if err := s.ensureDaemon(); err != nil {
		st.State = "error"
		st.Error = "Tailscale could not start. Try reconnecting."
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
	if raw, err = s.run("funnel", "status", "--json"); err == nil {
		if json.Unmarshal([]byte(raw), &serveConfig) == nil {
			st.PublicURL, st.PrivateURL = configuredURLs(serveConfig, nodeURL, fmt.Sprintf("http://127.0.0.1:%d", s.port))
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
	st := TailscaleStatus{Installed: true, Version: TailscaleVersion, PublicSupported: true, State: s.devScenario, IdentitySaved: s.devScenario != "off"}
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
	return nil
}
func (s *TailscaleService) Connect() (TailscaleStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
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
	target := fmt.Sprintf("http://127.0.0.1:%d", s.port)
	var out string
	var err error
	if public {
		out, err = s.run("funnel", "--bg", "--https=443", target)
	} else {
		if _, err := s.run("funnel", "reset"); err != nil {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.disableLocked()
}
func (s *TailscaleService) disableLocked() (TailscaleStatus, error) {
	if s.devScenario != "" {
		s.mockMu.Lock()
		s.devScenario = "off"
		s.devPublic = false
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		if err := s.ensureDaemon(); err != nil {
			return TailscaleStatus{}, err
		}
		if _, err := s.run("funnel", "reset"); err != nil {
			return TailscaleStatus{}, err
		}
		if _, err := s.run("serve", "reset"); err != nil {
			return TailscaleStatus{}, err
		}
		if _, err := s.run("down"); err != nil {
			return TailscaleStatus{}, err
		}
	}
	_ = os.Remove(filepath.Join(s.dir, "enabled"))
	_ = os.Remove(filepath.Join(s.dir, "private-enabled"))
	_ = os.Remove(filepath.Join(s.dir, "approval-type"))
	_ = os.Remove(filepath.Join(s.dir, "auth-url"))
	_ = os.Remove(filepath.Join(s.dir, "approval-url"))
	return s.statusLocked(), nil
}
func (s *TailscaleService) Forget() (TailscaleStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.devScenario != "" {
		s.mockMu.Lock()
		s.devScenario = "off"
		s.devPublic = false
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	if _, err := s.disableLocked(); err != nil {
		return TailscaleStatus{}, err
	}
	if tailscaleFileExists(s.sock()) {
		_, _ = s.run("logout")
	}
	if b, e := os.ReadFile(filepath.Join(s.dir, "tailscaled.pid")); e == nil {
		if pid, e := strconv.Atoi(strings.TrimSpace(string(b))); e == nil {
			cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
			parts := strings.Split(string(cmdline), "\x00")
			if len(parts) > 0 && filepath.Base(parts[0]) == filepath.Base(s.daemon()) && strings.Contains(string(cmdline), filepath.Join(s.dir, "tailscaled.state")) {
				if p, e := os.FindProcess(pid); e == nil {
					if e := p.Kill(); e != nil && s.managedDaemonAlive() {
						return TailscaleStatus{}, e
					}
					stopped := false
					for i := 0; i < 40; i++ {
						if !s.managedDaemonAlive() {
							stopped = true
							break
						}
						time.Sleep(50 * time.Millisecond)
					}
					if !stopped {
						return TailscaleStatus{}, fmt.Errorf("Tailscale did not stop; its saved identity was kept")
					}
				}
			}
		}
	}
	_ = os.Remove(filepath.Join(s.dir, "tailscaled.state"))
	_ = os.Remove(filepath.Join(s.dir, "tailscaled.pid"))
	_ = os.Remove(s.sock())
	return s.statusLocked(), nil
}

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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const TailscaleVersion = "1.104.2"

type TailscaleStatus struct {
	Installed         bool   `json:"installed"`
	Enabled           bool   `json:"enabled"`
	IdentitySaved     bool   `json:"identity_saved"`
	State             string `json:"state"`
	PrivateURL        string `json:"private_url"`
	PublicURL         string `json:"public_url"`
	AuthURL           string `json:"auth_url"`
	ApprovalURL       string `json:"approval_url"`
	ApprovalType      string `json:"approval_type"`
	Error             string `json:"error"`
	ResidualExposure  bool   `json:"residual_exposure"`
	StopServeFallback bool   `json:"stop_serve_fallback,omitempty"`
	ControlServer     string `json:"control_server"`
}

// An empty control server selects Tailscale's official coordination service.
// A custom server is deliberately restricted to an HTTPS origin: it controls
// the node's identity and the login URL shown to an administrator.
func normalizeControlServer(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Port() == "0" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", errors.New("Headscale needs an HTTPS server address without a path")
	}
	host := strings.ToLower(u.Host)
	if u.Port() == "443" {
		host = strings.TrimSuffix(host, ":443")
	}
	return "https://" + host, nil
}

func (s *TailscaleService) controlServer() (string, error) {
	b, err := os.ReadFile(filepath.Join(s.dir, "control-server"))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return normalizeControlServer(string(b))
}

type TailscaleService struct {
	resetGate      sync.RWMutex
	dir            string
	port           int
	mu             sync.Mutex
	mockMu         sync.Mutex
	devScenario    string
	devPublic      bool
	devControl     string
	restoreDone    chan struct{}
	cleanupDone    chan struct{}
	cleanupErr     error
	listenerReady  chan struct{}
	listenerOnce   sync.Once
	listenerError  error
	listenerTarget string
	listenerLive   atomic.Bool
	authority      atomic.Value // approved HTTPS URL or empty string
	restoreCancel  chan struct{}
	cancelOnce     sync.Once
	shuttingDown   bool // protected by mu; forbids restarting after shutdown
	ownedDaemon    bool // protected by lifecycle mutex
}

// LockReset excludes remote-access mutations until account reset is complete.
func (s *TailscaleService) LockReset()      { s.resetGate.Lock() }
func (s *TailscaleService) UnlockReset()    { s.resetGate.Unlock() }
func (s *TailscaleService) LockMutation()   { s.resetGate.RLock() }
func (s *TailscaleService) UnlockMutation() { s.resetGate.RUnlock() }

func NewTailscaleService(dataDir string, port int) *TailscaleService {
	s := &TailscaleService{dir: filepath.Join(dataDir, "tailscale"), port: port,
		listenerReady: make(chan struct{}), restoreCancel: make(chan struct{}), cleanupDone: make(chan struct{})}
	s.authority.Store("")
	if strings.EqualFold(os.Getenv("SOL_INSECURE_DEV"), "true") {
		s.devScenario = os.Getenv("SOL_TAILSCALE_SCENARIO")
	}
	if s.devScenario == "" && tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		// Gate mutations until this bounded restore finishes, without holding
		// the status mutex through daemon readiness. Status remains readable.
		s.restoreDone = make(chan struct{})
		go func() {
			defer close(s.restoreDone)
			defer s.finishCleanupIfPending()
			err := s.restoreForWebListener()
			if err != nil {
				slog.Warn("Could not restore Tailscale at startup", "error", err)
				mode, _ := os.ReadFile(filepath.Join(s.dir, "restore-failed-mode"))
				if string(mode) != "private" && string(mode) != "public" {
					mode = []byte("unknown")
				}
				if markerErr := s.persistRestoreMode(string(mode)); markerErr != nil {
					slog.Error("Could not record failed Tailscale web restoration", "error", markerErr)
				}
				// restoreDone remains open through this cleanup. Mutations reject
				// or wait for restore; StopForShutdown waits before taking mu
				// and writing shuttingDown. Do not close restoreDone early or
				// move a lifecycle write ahead of waitForRestore.
				st, offErr := s.disableLocked()
				if offErr != nil {
					slog.Warn("Could not persist Tailscale shutdown after restore failure", "error", offErr)
				}
				if !st.ResidualExposure && !tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
					_ = os.WriteFile(filepath.Join(s.dir, "last-error"), []byte("Tailscale could not restore remote access. Try connecting again."), 0600)
				}
			}
		}()
	} else if s.devScenario == "" && (tailscaleFileExists(filepath.Join(s.dir, "launch-intent")) || tailscaleFileExists(s.sock())) {
		s.restoreDone = make(chan struct{})
		go func() {
			defer close(s.restoreDone)
			if err := s.stopDaemon(); err != nil {
				s.cleanupErr = err
				_ = os.WriteFile(filepath.Join(s.dir, "stop-failed"), []byte("unverified"), 0600)
				slog.Warn("Could not verify old Tailscale process stopped", "error", err)
			}
			close(s.cleanupDone)
		}()
	} else if s.devScenario == "" && tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")) {
		s.restoreDone = make(chan struct{})
		go func() {
			defer close(s.restoreDone)
			s.cleanupErr = s.stopDaemon()
			if s.cleanupErr != nil {
				_ = os.WriteFile(filepath.Join(s.dir, "stop-failed"), []byte("unverified"), 0600)
			}
			close(s.cleanupDone)
		}()
	} else {
		close(s.cleanupDone)
	}
	return s
}

func (s *TailscaleService) finishCleanupIfPending() {
	select {
	case <-s.cleanupDone:
	default:
		s.cleanupErr = errors.New("Tailscale cleanup could not be verified")
		close(s.cleanupDone)
	}
}

// WaitLegacyCleanup gates ordinary HTTP until an old TCP target is gone.
func (s *TailscaleService) WaitLegacyCleanup() error {
	if s.cleanupDone == nil {
		return nil
	}
	<-s.cleanupDone
	return s.cleanupErr
}

// UnixListenerReady publishes the exclusive generation target only after bind.
func (s *TailscaleService) UnixListenerReady(path string, bindErr error) {
	s.listenerOnce.Do(func() {
		if bindErr != nil {
			s.listenerError = bindErr
		} else if path == "" {
			s.listenerError = errors.New("Tailscale needs a private Unix listener")
		} else {
			s.listenerTarget = "unix:" + path
			s.listenerLive.Store(true)
		}
		close(s.listenerReady)
	})
}

func (s *TailscaleService) UnixListenerStopped() { s.listenerLive.Store(false) }

func (s *TailscaleService) ApprovedURL() string {
	value, _ := s.authority.Load().(string)
	return value
}

func (s *TailscaleService) webTarget() string {
	if s.listenerReady == nil {
		return ""
	}
	select {
	case <-s.listenerReady:
		if s.listenerLive.Load() {
			return s.listenerTarget
		}
		return ""
	default:
		return ""
	}
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
	if s.listenerError == nil && s.listenerTarget == "" {
		return errors.New("Tailscale needs a private Unix listener")
	}
	if s.listenerError == nil && !s.listenerLive.Load() {
		return errors.New("Tailscale's private listener stopped")
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
	err := s.stopDaemon()
	if err != nil {
		_ = os.WriteFile(filepath.Join(s.dir, "stop-failed"), []byte("unverified"), 0600)
	}
	return err
}

func (s *TailscaleService) restoreForWebListener() error {
	// Complete an interrupted disable without restarting or restoring access.
	// Remove opt-in first, before clearAccessIfRequired removes the marker.
	if tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
		if err := os.Remove(filepath.Join(s.dir, "enabled")); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := s.stopDaemon(); err != nil {
			s.cleanupErr = err
			close(s.cleanupDone)
			return err
		}
		err := s.clearAccessIfRequired()
		close(s.cleanupDone)
		return err
	}
	if err := s.stopDaemon(); err != nil {
		return err
	}
	mode, err := s.savedServeMode()
	if err != nil {
		close(s.cleanupDone)
		return err
	}
	// Retain Admin intent across a failed bind or interrupted startup, before
	// deleting the old proxy target. Never persist the old target itself.
	if mode != "" {
		if err := os.WriteFile(filepath.Join(s.dir, "restore-serve"), []byte(mode), 0600); err != nil {
			close(s.cleanupDone)
			return err
		}
		if err := s.persistRestoreMode(mode); err != nil {
			close(s.cleanupDone)
			return err
		}
	}
	if err := s.clearSavedServe(); err != nil {
		close(s.cleanupDone)
		return err
	}
	close(s.cleanupDone)
	select {
	case <-s.restoreCancel:
		return nil
	case <-s.listenerReady:
	}
	if s.listenerError != nil {
		return s.listenerError
	}
	if err := s.requireWebListener(); err != nil {
		return err
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

func (s *TailscaleService) persistRestoreMode(mode string) error {
	f, err := os.CreateTemp(s.dir, ".restore-mode-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(mode); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Link(f.Name(), filepath.Join(s.dir, "restore-failed-mode")); err != nil {
		if os.IsExist(err) {
			return nil
		}
		return err
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
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
	return productBinary
}
func (s *TailscaleService) daemon() string {
	if v := os.Getenv("SOL_TAILSCALED"); v != "" {
		return v
	}
	productBinary := "/usr/local/lib/sol/tailscale/" + TailscaleVersion + "/tailscaled"
	return productBinary
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
		return errors.New("Tailscale is off. Sign out of Tailscale before connecting again")
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
		_ = os.WriteFile(filepath.Join(s.dir, "stop-failed"), []byte("unverified"), 0600)
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
	_ = os.Remove(filepath.Join(s.dir, "stop-failed"))
	s.clearResolvedWarning()
	return nil
}

func tailscaleProcessStart(pid int) (string, error) {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	at := strings.LastIndexByte(string(raw), ')')
	if at < 0 {
		return "", errors.New("unreadable Tailscale process identity")
	}
	fields := strings.Fields(string(raw[at+1:]))
	if len(fields) <= 19 {
		return "", errors.New("unreadable Tailscale process identity")
	}
	return fields[19], nil
}

func tailscaleBootID() (string, error) {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(string(raw))
	if len(value) != 36 {
		return "", errors.New("could not verify the current boot")
	}
	for _, r := range value {
		if !strings.ContainsRune("0123456789abcdefABCDEF-", r) {
			return "", errors.New("invalid boot identity")
		}
	}
	return value, nil
}

func (s *TailscaleService) validStopProof() bool {
	value, err := os.ReadFile(filepath.Join(s.dir, "stop-verified"))
	if err != nil || len(value) != 36 {
		return false
	}
	for _, c := range value {
		if !strings.ContainsRune("0123456789abcdefABCDEF-", rune(c)) {
			return false
		}
	}
	return true
}

func (s *TailscaleService) retireLaunch() error {
	if _, err := os.Stat(s.dir); err == nil {
		boot, err := tailscaleBootID()
		if err != nil {
			return err
		}
		f, err := os.OpenFile(filepath.Join(s.dir, "stop-verified"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
		if err != nil {
			return err
		}
		if _, err = f.WriteString(boot); err == nil {
			err = f.Sync()
		}
		if e := f.Close(); err == nil {
			err = e
		}
		if err != nil {
			return err
		}
		dir, err := os.Open(s.dir)
		if err != nil {
			return err
		}
		err = dir.Sync()
		_ = dir.Close()
		if err != nil {
			return err
		}
	}
	for _, name := range []string{"tailscaled.pid", "launch-intent"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if dir, err := os.Open(s.dir); err == nil {
		defer dir.Close()
		if err := dir.Sync(); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	s.ownedDaemon = false
	return nil
}

func (s *TailscaleService) writeLaunchIntent(value string, exclusive bool) error {
	path := filepath.Join(s.dir, "launch-intent")
	if exclusive {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if _, err = f.WriteString(value); err == nil {
			err = f.Sync()
		}
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	} else {
		f, err := os.CreateTemp(s.dir, ".launch-*")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		if _, err = f.WriteString(value); err == nil {
			err = f.Sync()
		}
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
		if err = os.Rename(f.Name(), path); err != nil {
			return err
		}
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (s *TailscaleService) ensureDaemon() error {
	if s.shuttingDown {
		return errors.New("Sol is shutting down")
	}
	// Never start a node we cannot later stop without risking PID reuse.
	fd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		return fmt.Errorf("Tailscale is unavailable: process identity protection is not supported: %w", err)
	}
	err = unix.PidfdSendSignal(fd, 0, nil, 0)
	_ = unix.Close(fd)
	if err != nil {
		return fmt.Errorf("Tailscale is unavailable: process identity protection is not permitted: %w", err)
	}
	if err := s.clearAccessIfRequired(); err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	if !s.ownedDaemon && tailscaleFileExists(filepath.Join(s.dir, "launch-intent")) {
		return errors.New("a previous Tailscale start needs verification")
	}
	if !s.ownedDaemon && tailscaleFileExists(s.sock()) {
		if err := s.verifySocketStopped(); err != nil {
			return err
		}
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
	boot, err := tailscaleBootID()
	if err != nil {
		return err
	}
	if err := s.writeLaunchIntent("pending "+boot, true); err != nil {
		return fmt.Errorf("a previous Tailscale start could not be verified: %w", err)
	}
	if err := os.Remove(filepath.Join(s.dir, "stop-verified")); err != nil && !os.IsNotExist(err) {
		return err
	}
	cmd := exec.Command(s.daemon(), "--state", filepath.Join(s.dir, "tailscaled.state"), "--socket", s.sock(), "--tun=userspace-networking")
	cmd.Stdin = nil
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		if retireErr := s.retireLaunch(); retireErr != nil {
			return errors.Join(err, retireErr)
		}
		return fmt.Errorf("could not start Tailscale: %w", err)
	}
	cleanupFailedLaunch := func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		if cmd.ProcessState != nil && s.verifySocketStopped() == nil {
			_ = s.retireLaunch()
		}
	}
	start, err := tailscaleProcessStart(cmd.Process.Pid)
	if err != nil {
		cleanupFailedLaunch()
		return err
	}
	if err := s.writeLaunchIntent(fmt.Sprintf("%d %s %s", cmd.Process.Pid, start, boot), false); err != nil {
		cleanupFailedLaunch()
		return err
	}
	if err := os.WriteFile(filepath.Join(s.dir, "tailscaled.pid"), []byte(fmt.Sprint(cmd.Process.Pid)), 0600); err != nil {
		cleanupFailedLaunch()
		return err
	}
	go func() { _ = cmd.Wait() }()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if _, err := s.run("status", "--json"); err == nil {
			_ = os.Chmod(s.sock(), 0600)
			s.ownedDaemon = true
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
	if !s.ownedDaemon && tailscaleFileExists(filepath.Join(s.dir, "launch-intent")) {
		st := s.statusLocked()
		st.State, st.ResidualExposure = "error", true
		st.Error = "Sol could not verify that Tailscale stopped."
		return st
	}
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
	control, err := s.controlServer()
	if err != nil {
		st.State, st.Error = "error", "Sol could not read the remote access server."
		st.ResidualExposure = tailscaleFileExists(filepath.Join(s.dir, "stop-failed"))
		return st
	}
	st.ControlServer = control
	if warning, err := os.ReadFile(filepath.Join(s.dir, "last-error")); err == nil {
		st.Error = strings.TrimSpace(string(warning))
	}
	if st.Error == "" && tailscaleFileExists(filepath.Join(s.dir, "restore-failed-mode")) {
		st.Error = "Tailscale could not restore web access. Try turning it on again."
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
		st.ResidualExposure = true
		st.Error = "Tailscale could not read its connection status. Try reconnecting."
		return st
	}
	var data map[string]any
	if json.Unmarshal([]byte(raw), &data) != nil {
		st.State = "error"
		st.ResidualExposure = true
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
	if backend == "NeedsMachineAuth" && control != "" {
		st.Error = "Ask your Headscale administrator to approve this device."
	} else if backend == "NeedsMachineAuth" {
		st.AuthURL = "https://login.tailscale.com/admin/machines"
	} else if backend == "NeedsLogin" {
		st.AuthURL, _ = data["AuthURL"].(string)
		if !allowedTailscaleAuthURL(st.AuthURL, control) {
			st.AuthURL = ""
		}
		if st.AuthURL != "" {
			_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(st.AuthURL), 0600)
		}
	} else {
		_ = os.Remove(filepath.Join(s.dir, "auth-url"))
	}
	var serveConfig map[string]any
	if raw, err = s.run("serve", "status", "--json"); err != nil || json.Unmarshal([]byte(raw), &serveConfig) != nil {
		st.State, st.ResidualExposure = "error", true
		st.Error = "Sol could not check whether public access is on."
		return st
	} else {
		st.PublicURL, st.PrivateURL = configuredURLsForControl(serveConfig, nodeURL, s.webTarget(), control != "")
		if st.State == "connected" && ((st.ApprovalType == "funnel" && st.PublicURL != "") || (st.ApprovalType == "https" && st.PrivateURL != "")) {
			st.ApprovalURL, st.ApprovalType = "", ""
			_ = os.Remove(filepath.Join(s.dir, "approval-url"))
			_ = os.Remove(filepath.Join(s.dir, "approval-type"))
		}
	}
	if st.State != "connected" {
		st.PublicURL, st.PrivateURL = "", ""
	}
	if mode, err := os.ReadFile(filepath.Join(s.dir, "restore-failed-mode")); err == nil && !tailscaleFileExists(filepath.Join(s.dir, "reset-required")) && !tailscaleFileExists(filepath.Join(s.dir, "stop-failed")) && ((string(mode) == "private" && st.PrivateURL != "") || (string(mode) == "public" && st.PublicURL != "")) {
		if os.Remove(filepath.Join(s.dir, "restore-failed-mode")) == nil && (st.Error == "Tailscale could not restore web access. Try turning it on again." || st.Error == "Tailscale could not restore remote access. Try connecting again.") {
			s.clearRestorationWarning()
			st.Error = ""
		}
	}
	if st.PublicURL != "" {
		s.authority.Store(st.PublicURL)
	} else if st.PrivateURL != "" {
		s.authority.Store(st.PrivateURL)
	}
	return st
}

func (s *TailscaleService) mockStatusLocked() TailscaleStatus {
	st := TailscaleStatus{Installed: true, State: s.devScenario, IdentitySaved: s.devScenario != "off", ControlServer: s.devControl}
	switch s.devScenario {
	case "off":
		st.State = "off"
	case "pending":
		st.Enabled = true
		st.State = "pending"
		st.AuthURL = "https://login.tailscale.com/a/dev-preview"
		if s.devControl != "" {
			st.AuthURL = s.devControl + "/register/demo"
		}
	case "failure":
		st.Enabled = true
		st.State = "error"
		st.Error = "The development Tailscale service is unavailable."
	case "connected", "served", "funnel", "approval":
		st.Enabled = true
		st.State = "connected"
		if s.devScenario != "connected" {
			st.PrivateURL = "https://sol-dev.tail-demo.ts.net"
			if s.devControl != "" {
				st.PrivateURL = "https://sol.headscale.example.net"
			}
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
	return configuredURLsForControl(v, privateURL, expectedProxy, false)
}

func configuredURLsForControl(v any, privateURL, expectedProxy string, headscale bool) (publicURL, private string) {
	root, _ := v.(map[string]any)
	web, _ := root["Web"].(map[string]any)
	allow, _ := root["AllowFunnel"].(map[string]any)
	node, _ := url.Parse(privateURL)
	if node == nil || node.Scheme != "https" || node.Hostname() == "" || node.User != nil || node.Port() != "" || node.Path != "" || node.RawQuery != "" || node.Fragment != "" {
		return "", ""
	}
	for listener := range web {
		if !strings.HasSuffix(listener, ":443") {
			continue
		}
		host := strings.TrimSuffix(listener, ":443")
		u, err := url.Parse("https://" + host)
		if err != nil || u.Hostname() == "" || u.User != nil || u.Port() != "" || u.Path != "" || !strings.EqualFold(u.Hostname(), node.Hostname()) || (!headscale && !strings.HasSuffix(strings.ToLower(u.Hostname()), ".ts.net")) {
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
			if headscale {
				return "", ""
			}
			return u.String(), ""
		}
		return "", privateURL
	}
	return "", ""
}

func allowedTailscaleAuthURL(raw, control string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return false
	}
	if control == "" {
		return strings.EqualFold(u.Hostname(), "login.tailscale.com") && (u.Port() == "" || u.Port() == "443")
	}
	c, err := url.Parse(control)
	if err != nil || !strings.EqualFold(u.Hostname(), c.Hostname()) {
		return false
	}
	port := func(u *url.URL) string {
		if u.Port() == "" {
			return "443"
		}
		return u.Port()
	}
	return port(u) == port(c)
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
func (s *TailscaleService) clearResolvedWarning() {
	if tailscaleFileExists(filepath.Join(s.dir, "stop-failed")) || tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
		return
	}
	path := filepath.Join(s.dir, "last-error")
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	msg := string(b)
	if msg == "Tailscale may still be reachable. Sol could not verify that its remote connection stopped." || msg == "Tailscale is off. Sign out of Tailscale before connecting again." {
		_ = os.Remove(path)
	}
}
func (s *TailscaleService) clearRestorationWarning() {
	if tailscaleFileExists(filepath.Join(s.dir, "stop-failed")) || tailscaleFileExists(filepath.Join(s.dir, "reset-required")) || tailscaleFileExists(filepath.Join(s.dir, "restore-failed-mode")) {
		return
	}
	path := filepath.Join(s.dir, "last-error")
	if b, err := os.ReadFile(path); err == nil && (string(b) == "Tailscale could not restore remote access. Try connecting again." || string(b) == "Tailscale could not restore web access. Try turning it on again.") {
		_ = os.Remove(path)
	}
}
func (s *TailscaleService) up() error {
	control, err := s.controlServer()
	if err != nil {
		return err
	}
	args := []string{"up", "--accept-dns=false", "--json", "--timeout=2s"}
	if control != "" {
		args = append(args, "--login-server="+control)
	}
	raw, err := s.run(args...)
	if err != nil {
		var v map[string]any
		rawErr := err.Error()
		start, end := strings.Index(rawErr, "{"), strings.LastIndex(rawErr, "}")
		if start >= 0 && end >= start && json.Unmarshal([]byte(rawErr[start:end+1]), &v) == nil {
			if auth, ok := v["AuthURL"].(string); ok && allowedTailscaleAuthURL(auth, control) {
				_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(auth), 0600)
				s.clearResolvedWarning()
				return nil
			}
		}
		return err
	}
	var v map[string]any
	if json.Unmarshal([]byte(raw), &v) == nil {
		if auth, ok := v["AuthURL"].(string); ok && allowedTailscaleAuthURL(auth, control) {
			_ = os.WriteFile(filepath.Join(s.dir, "auth-url"), []byte(auth), 0600)
		}
	}
	s.clearResolvedWarning()
	return nil
}
func (s *TailscaleService) Connect() (TailscaleStatus, error) {
	return s.ConnectWithControl("")
}

// ConnectWithControl never switches a saved identity to a different server.
// Forget first, after the existing listener has been verified stopped.
func (s *TailscaleService) ConnectWithControl(selected string) (TailscaleStatus, error) {
	selected, err := normalizeControlServer(selected)
	if err != nil {
		return TailscaleStatus{}, err
	}
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
		if s.devScenario != "off" && !strings.EqualFold(s.devControl, selected) {
			s.mockMu.Unlock()
			return TailscaleStatus{}, errors.New("Sign out of Tailscale before changing the server")
		}
		s.devControl = selected
		if s.devScenario == "off" {
			s.devScenario = "pending"
		}
		st := s.mockStatusLocked()
		s.mockMu.Unlock()
		return st, nil
	}
	current, err := s.controlServer()
	if err != nil {
		return TailscaleStatus{}, err
	}
	if (tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")) || tailscaleFileExists(filepath.Join(s.dir, "enabled")) || tailscaleFileExists(s.sock()) || tailscaleFileExists(filepath.Join(s.dir, "launch-intent")) || tailscaleFileExists(filepath.Join(s.dir, "stop-failed"))) && !strings.EqualFold(current, selected) {
		return TailscaleStatus{}, errors.New("Sign out of Tailscale before changing the server")
	}
	if !strings.EqualFold(current, selected) {
		if err := s.stopDaemon(); err != nil {
			return TailscaleStatus{}, err
		}
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return TailscaleStatus{}, err
	}
	tmp, err := os.CreateTemp(s.dir, ".control-server-*")
	if err != nil {
		return TailscaleStatus{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.WriteString(selected); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return TailscaleStatus{}, err
	}
	if err = os.Rename(tmp.Name(), filepath.Join(s.dir, "control-server")); err != nil {
		return TailscaleStatus{}, err
	}
	dir, err := os.Open(s.dir)
	if err != nil {
		return TailscaleStatus{}, err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return TailscaleStatus{}, err
	}
	if closeErr != nil {
		return TailscaleStatus{}, closeErr
	}
	wasEnabled := tailscaleFileExists(filepath.Join(s.dir, "enabled"))
	if err := s.ensureDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	if err := s.up(); err != nil {
		if !wasEnabled {
			st, stopErr := s.disableLocked()
			if stopErr != nil {
				return st, stopErr
			}
			if st.ResidualExposure {
				return st, errors.New("Tailscale may still be reachable. Sol could not verify that its remote connection stopped")
			}
		}
		return TailscaleStatus{}, err
	}
	if err := os.WriteFile(filepath.Join(s.dir, "enabled"), []byte("1"), 0600); err != nil {
		st, stopErr := s.disableLocked()
		if stopErr != nil {
			return st, stopErr
		}
		if st.ResidualExposure {
			return st, errors.New("Tailscale may still be reachable. Sol could not verify that its remote connection stopped")
		}
		return TailscaleStatus{}, err
	}
	s.clearResolvedWarning()
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
	s.clearResolvedWarning()
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
	st, err := s.serveLocked(public)
	if err == nil && !public && st.ControlServer != "" && st.PrivateURL == "" {
		return st, errors.New("Headscale has not reported a private HTTPS address. Check its connection and certificate settings.")
	}
	return st, err
}

func (s *TailscaleService) serveLocked(public bool) (TailscaleStatus, error) {
	if s.shuttingDown {
		return TailscaleStatus{}, errors.New("Sol is shutting down")
	}
	if err := s.requireWebListener(); err != nil {
		return TailscaleStatus{}, err
	}
	control, err := s.controlServer()
	if err != nil {
		return TailscaleStatus{}, err
	}
	if public && control != "" {
		return TailscaleStatus{}, errors.New("Public access is not available with Headscale")
	}
	if s.devScenario != "" {
		s.mockMu.Lock()
		if public && s.devControl != "" {
			s.mockMu.Unlock()
			return TailscaleStatus{}, errors.New("Public access is not available with Headscale")
		}
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
	if !tailscaleFileExists(filepath.Join(s.dir, "enabled")) {
		return TailscaleStatus{}, fmt.Errorf("connect Tailscale first")
	}
	if !public {
		// Persist reduced exposure before any fallible reconnect or setup.
		// ensureDaemon stops the old process and clears its saved Serve state.
		if err := os.WriteFile(filepath.Join(s.dir, "reset-required"), []byte("1"), 0600); err != nil {
			return TailscaleStatus{}, err
		}
		if err := removeTailscalePendingMode(s.dir); err != nil {
			return TailscaleStatus{}, err
		}
	}
	if err := s.ensureDaemon(); err != nil {
		return TailscaleStatus{}, err
	}
	if err := s.up(); err != nil {
		return TailscaleStatus{}, err
	}
	target := s.webTarget()
	var out string
	// err already holds the validated control-server result above.
	if public {
		out, err = s.run("funnel", "--bg", "--https=443", target)
	} else {
		if _, err := s.run("serve", "reset"); err != nil {
			return TailscaleStatus{}, err
		}
		out, err = s.run("serve", "--bg", "--https=443", target)
	}
	if err != nil {
		if u := approvalURL(err.Error()); control == "" && u != "" {
			_ = os.WriteFile(filepath.Join(s.dir, "approval-url"), []byte(u), 0600)
			_ = os.WriteFile(filepath.Join(s.dir, "approval-type"), []byte(map[bool]string{true: "funnel", false: "https"}[public]), 0600)
			return s.statusLocked(), nil
		}
		if control != "" {
			return TailscaleStatus{}, errors.New("Sol could not turn on private access. Check your Headscale connection and HTTPS certificate settings.")
		}
		return TailscaleStatus{}, err
	}
	if u := approvalURL(out); control == "" && u != "" {
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
	st, err := s.disableLocked()
	if err == nil && !st.ResidualExposure && !tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
		_ = os.Remove(filepath.Join(s.dir, "restore-failed-mode"))
		s.clearResolvedWarning()
		s.clearRestorationWarning()
		return s.statusLocked(), nil
	}
	return st, err
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
		slog.Warn("Could not reset Tailscale web access; stopping the managed daemon", "error", err)
		status, err := s.disableLocked()
		if err == nil && !status.ResidualExposure && !tailscaleFileExists(filepath.Join(s.dir, "reset-required")) {
			_ = os.Remove(filepath.Join(s.dir, "restore-failed-mode"))
			s.clearResolvedWarning()
			s.clearRestorationWarning()
			status = s.statusLocked()
		}
		status.StopServeFallback = true
		return status, err
	}
	_ = os.Remove(filepath.Join(s.dir, "restore-failed-mode"))
	s.clearResolvedWarning()
	s.clearRestorationWarning()
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
		message := "Tailscale may still be reachable. Sol could not verify that its remote connection stopped."
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
		_ = os.WriteFile(filepath.Join(s.dir, "last-error"), []byte("Tailscale is off. Sign out of Tailscale before connecting again."), 0600)
	} else {
		s.clearResolvedWarning()
	}
	return s.statusLocked(), nil
}

func (s *TailscaleService) stopDaemon() error {
	s.authority.Store("")
	intent, intentErr := os.ReadFile(filepath.Join(s.dir, "launch-intent"))
	var raw []byte
	var start string
	if intentErr == nil {
		fields := strings.Fields(string(intent))
		if len(fields) < 2 {
			return errors.New("a previous Tailscale start could not be verified")
		}
		boot, err := tailscaleBootID()
		if err != nil {
			return err
		}
		if fields[0] == "pending" && len(fields) == 2 {
			if fields[1] != boot {
				return s.retireLaunch()
			}
			return errors.New("a previous Tailscale start could not be verified")
		}
		if len(fields) != 3 {
			return errors.New("a previous Tailscale start could not be verified")
		}
		if fields[2] != boot {
			return s.retireLaunch()
		}
		raw, start = []byte(fields[0]), fields[1]
	} else if !os.IsNotExist(intentErr) {
		return intentErr
	} else {
		if s.validStopProof() {
			return s.verifySocketStopped()
		}
		var err error
		raw, err = os.ReadFile(filepath.Join(s.dir, "tailscaled.pid"))
		if err != nil {
			if !s.validStopProof() && (tailscaleFileExists(filepath.Join(s.dir, "tailscaled.state")) || tailscaleFileExists(filepath.Join(s.dir, "enabled")) || tailscaleFileExists(s.sock())) {
				return errors.New("an older Tailscale process could not be verified")
			}
			return s.verifySocketStopped()
		}
	}
	if intentErr != nil {
		return errors.New("an older Tailscale process cannot be safely identified")
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 1 {
		return errors.New("Tailscale's process identity is invalid")
	}
	fd, err := unix.PidfdOpen(pid, 0)
	if errors.Is(err, unix.ESRCH) {
		if err := s.verifySocketStopped(); err != nil {
			return err
		}
		return s.retireLaunch()
	}
	if err != nil {
		return fmt.Errorf("could not pin Tailscale process identity: %w", err)
	}
	defer unix.Close(fd)
	if start != "" {
		actual, err := tailscaleProcessStart(pid)
		if err != nil {
			return err
		}
		if actual != start {
			if err := s.verifySocketStopped(); err != nil {
				return err
			}
			return s.retireLaunch()
		}
	}
	verifiedPID, alive := s.managedDaemonPID()
	if start != "" {
		// The durable identity is authoritative even if the legacy PID file
		// was not written before a crash.
		cmdline, readErr := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		parts := strings.Split(string(cmdline), "\x00")
		alive = readErr == nil && len(parts) > 0 && filepath.Base(parts[0]) == filepath.Base(s.daemon())
		found := false
		for i, part := range parts {
			if part == "--state="+filepath.Join(s.dir, "tailscaled.state") || (part == "--state" && i+1 < len(parts) && parts[i+1] == filepath.Join(s.dir, "tailscaled.state")) {
				found = true
			}
		}
		alive, verifiedPID = alive && found, pid
	}
	if !alive || verifiedPID != pid {
		return errors.New("Tailscale's process ownership could not be verified")
	}
	if err := unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0); err != nil && !errors.Is(err, unix.ESRCH) {
		return err
	}
	for i := 0; i < 40; i++ {
		poll := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		if n, err := unix.Poll(poll, 0); err == nil && n > 0 && poll[0].Revents&unix.POLLIN != 0 {
			if err := s.verifySocketStopped(); err == nil {
				return s.retireLaunch()
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
	// Repair invalid control metadata only after verified stop.
	controlPath := filepath.Join(s.dir, "control-server")
	if raw, readErr := os.ReadFile(controlPath); readErr == nil {
		if _, invalid := normalizeControlServer(string(raw)); invalid != nil {
			if removeErr := os.Remove(controlPath); removeErr != nil && !os.IsNotExist(removeErr) {
				return TailscaleStatus{}, removeErr
			}
		}
	} else if !os.IsNotExist(readErr) {
		return TailscaleStatus{}, readErr
	}
	for _, name := range []string{"tailscaled.state", "enabled"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			return TailscaleStatus{}, err
		}
	}
	for _, name := range []string{"tailscaled.pid", "tailscaled.sock", "restore-serve", "restore-failed-mode", "reset-required", "last-error", "stop-failed", "private-enabled", "approval-type", "approval-url", "auth-url"} {
		if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !os.IsNotExist(err) {
			slog.Warn("Could not remove old Tailscale metadata after verified stop and identity removal", "file", name, "error", err)
		}
	}
	return s.statusLocked(), nil
}

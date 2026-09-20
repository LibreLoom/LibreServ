package wifi

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// SetupSSID is the open network a phone joins when there is no cable and
// setup isn't finished yet. After the box is on home Wi-Fi (or a cable is
// plugged in), the hotspot is torn down.
const SetupSSID = "LibreServ Setup"

const hotspotCIDR = "10.42.0.1/24"
const hotspotIP = "10.42.0.1"

var ifaceNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

// SetupPortal is the temporary access-point used instead of a companion app.
type SetupPortal struct {
	mu      sync.Mutex
	iface   string
	runDir  string
	cache   []Network
	running bool
}

// NewSetupPortal binds a portal to a wireless interface and a directory for
// hostapd/dnsmasq pid and config files.
func NewSetupPortal(iface, runDir string) *SetupPortal {
	return &SetupPortal{iface: iface, runDir: runDir}
}

var activePortal struct {
	mu sync.Mutex
	p  *SetupPortal
}

// SetActivePortal records the process-wide setup hotspot (may be nil).
func SetActivePortal(p *SetupPortal) {
	activePortal.mu.Lock()
	defer activePortal.mu.Unlock()
	activePortal.p = p
}

// ActivePortal returns the process-wide setup hotspot, or nil.
func ActivePortal() *SetupPortal {
	activePortal.mu.Lock()
	defer activePortal.mu.Unlock()
	return activePortal.p
}

// HostapdConfig is the open (no password) hostapd file for the setup network.
func HostapdConfig(iface string) string {
	return fmt.Sprintf("interface=%s\ndriver=nl80211\nssid=%s\nhw_mode=g\nchannel=6\nwmm_enabled=1\n", iface, SetupSSID)
}

// SetCache stores networks scanned before the radio switched to AP mode.
func (p *SetupPortal) SetCache(nets []Network) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cache = nets
}

// CachedScan returns the pre-AP scan list.
func (p *SetupPortal) CachedScan() []Network {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cache == nil {
		return []Network{}
	}
	out := make([]Network, len(p.cache))
	copy(out, p.cache)
	return out
}

// Running reports whether the setup network is currently advertised.
func (p *SetupPortal) Running() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running
}

// Start advertises the open setup network. Idempotent.
func (p *SetupPortal) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return nil
	}
	if !ifaceNameRe.MatchString(p.iface) {
		return fmt.Errorf("Wi-Fi adapter name isn't usable")
	}
	if err := os.MkdirAll(p.runDir, 0o755); err != nil {
		return fmt.Errorf("could not prepare the setup network: %w", err)
	}
	conf := filepath.Join(p.runDir, "libreserv-setup-hostapd.conf")
	if err := os.WriteFile(conf, []byte(HostapdConfig(p.iface)), 0o600); err != nil {
		return fmt.Errorf("could not write the setup network settings: %w", err)
	}
	pidPath := p.hostapdPIDPath()
	out, err := exec.Command("hostapd", "-B", "-P", pidPath, conf).CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not start the setup network: %s", strings.TrimSpace(string(out)))
	}
	_ = exec.Command("ip", "addr", "add", hotspotCIDR, "dev", p.iface).Run()

	dnsPID := p.dnsmasqPIDPath()
	out, err = exec.Command("dnsmasq",
		"--no-resolv",
		"--no-poll",
		"--bind-interfaces",
		"--listen-address="+hotspotIP,
		"--dhcp-range=10.42.0.50,10.42.0.150,12h",
		"--dhcp-option=option:router,"+hotspotIP,
		"--interface", p.iface,
		"--except-interface=lo",
		"--address=/#/"+hotspotIP,
		"--pid-file="+dnsPID,
	).CombinedOutput()
	if err != nil {
		_ = p.killPIDFile(pidPath)
		return fmt.Errorf("could not start the setup network: %s", strings.TrimSpace(string(out)))
	}
	p.running = true
	return nil
}

// Stop tears down the setup network. Idempotent.
func (p *SetupPortal) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopLocked()
}

func (p *SetupPortal) stopLocked() error {
	if !p.running {
		_ = p.killPIDFile(p.hostapdPIDPath())
		return nil
	}
	_ = p.killPIDFile(p.hostapdPIDPath())
	_ = p.killPIDFile(p.dnsmasqPIDPath())
	_ = exec.Command("ip", "addr", "del", hotspotCIDR, "dev", p.iface).Run()
	p.running = false
	return nil
}

func (p *SetupPortal) hostapdPIDPath() string {
	return filepath.Join(p.runDir, "libreserv-setup-hostapd.pid")
}

func (p *SetupPortal) dnsmasqPIDPath() string {
	return filepath.Join(p.runDir, "libreserv-setup-dnsmasq.pid")
}

func (p *SetupPortal) killPIDFile(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	pid := strings.TrimSpace(string(raw))
	if pid == "" {
		return nil
	}
	_ = exec.Command("kill", pid).Run()
	_ = os.Remove(path)
	return nil
}

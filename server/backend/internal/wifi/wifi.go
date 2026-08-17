// Package wifi provides the same wireless abstraction Luna uses: wpa_cli on
// headless systems, with a no-op provider when no wireless interface exists.
package wifi

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Network is a visible Wi-Fi network.
type Network struct {
	SSID      string `json:"ssid"`
	Signal    int    `json:"signal"`
	Encrypted bool   `json:"encrypted"`
}

// Status describes the current Wi-Fi association.
type Status struct {
	Available bool   `json:"available"`
	Connected bool   `json:"connected"`
	SSID      string `json:"ssid,omitempty"`
	IPAddress string `json:"ip_address,omitempty"`
	State     string `json:"state"`
}

// Provider is the wireless backend. Implementations are process-safe and
// never log passphrases.
type Provider interface {
	Scan() ([]Network, error)
	Connect(ssid, passphrase string) error
	Status() (Status, error)
	Forget() error
}

// WpaCli drives wpa_supplicant through wpa_cli (headless/Alpine path).
type WpaCli struct {
	Interface string
}

// New returns a WpaCli provider bound to the named interface.
func New(iface string) Provider {
	return &WpaCli{Interface: iface}
}

// Auto returns a WpaCli provider bound to the first wireless interface, or a
// Noop provider when the device has no wireless radio at all. This is the
// production entry point so callers don't have to sniff interfaces themselves.
func Auto() Provider {
	if iface := FindWirelessInterface(); iface != "" {
		return &WpaCli{Interface: iface}
	}
	return Noop{}
}

// Noop reports Wi-Fi unavailable.
type Noop struct{}

func (Noop) Scan() ([]Network, error)     { return nil, fmt.Errorf("Wi-Fi isn't available on this device") }
func (Noop) Connect(string, string) error { return fmt.Errorf("Wi-Fi isn't available on this device") }
func (Noop) Forget() error                { return fmt.Errorf("Wi-Fi isn't available on this device") }
func (Noop) Status() (Status, error) {
	return Status{Available: false, State: "unavailable"}, nil
}

func (w *WpaCli) run(args ...string) (string, error) {
	full := append([]string{"-i", w.Interface}, args...)
	cmd := exec.Command("wpa_cli", full...)
	out, err := cmd.Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("the Wi-Fi tool said: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		return "", fmt.Errorf("could not reach the Wi-Fi tool: %w", err)
	}
	return string(out), nil
}

func (w *WpaCli) Scan() ([]Network, error) {
	if _, err := w.run("scan"); err != nil {
		return nil, err
	}
	time.Sleep(1500 * time.Millisecond)
	out, err := w.run("scan_results")
	if err != nil {
		return nil, err
	}
	return parseScanResults(out), nil
}

func (w *WpaCli) Connect(ssid, passphrase string) error {
	id, err := w.run("add_network")
	if err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	if _, err := w.run("set_network", id, "ssid", fmt.Sprintf("%q", ssid)); err != nil {
		return err
	}
	if passphrase == "" {
		if _, err := w.run("set_network", id, "key_mgmt", "NONE"); err != nil {
			return err
		}
	} else {
		if _, err := w.run("set_network", id, "psk", fmt.Sprintf("%q", passphrase)); err != nil {
			return err
		}
	}
	if _, err := w.run("enable_network", id); err != nil {
		return err
	}
	if _, err := w.run("select_network", id); err != nil {
		return err
	}
	_, _ = w.run("save_config")
	time.Sleep(3000 * time.Millisecond)
	status, err := w.Status()
	if err != nil {
		return err
	}
	if !status.Connected {
		return fmt.Errorf("That password didn't work. Check the sticker on your internet box and try again.")
	}
	return nil
}

func (w *WpaCli) Status() (Status, error) {
	out, err := w.run("status")
	if err != nil {
		return Status{Available: true, State: "error"}, err
	}
	status := Status{Available: true}
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "ssid":
			status.SSID = value
		case "ip_address":
			status.IPAddress = value
		case "wpa_state":
			status.State = value
		}
	}
	status.Connected = status.State == "COMPLETED"
	return status, nil
}

func (w *WpaCli) Forget() error {
	out, err := w.run("status")
	if err == nil {
		for _, line := range strings.Split(out, "\n") {
			key, value, ok := strings.Cut(line, "=")
			if ok && key == "id" {
				_, _ = w.run("remove_network", value)
				_, _ = w.run("save_config")
				return nil
			}
		}
	}
	return nil
}

func parseScanResults(out string) []Network {
	var networks []Network
	lines := strings.Split(out, "\n")
	for _, line := range lines[1:] {
		cols := strings.Split(line, "\t")
		if len(cols) < 5 {
			continue
		}
		ssid := strings.TrimSpace(cols[4])
		if ssid == "" {
			continue
		}
		signal, _ := strconv.Atoi(strings.TrimSpace(cols[2]))
		flags := cols[3]
		encrypted := strings.Contains(flags, "PSK") || strings.Contains(flags, "WPA") || strings.Contains(flags, "WEP")
		networks = append(networks, Network{SSID: ssid, Signal: signal, Encrypted: encrypted})
	}
	return networks
}

// FindWirelessInterface returns the first /sys/class/net interface with a
// wireless subdirectory, or "".
func FindWirelessInterface() string {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return ""
	}
	for _, entry := range entries {
		if _, err := os.Stat("/sys/class/net/" + entry.Name() + "/wireless"); err == nil {
			return entry.Name()
		}
	}
	return ""
}

// EthernetConnected reports whether any non-wireless interface has carrier.
func EthernetConnected() bool {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "lo" {
			continue
		}
		if _, err := os.Stat("/sys/class/net/" + name + "/wireless"); err == nil {
			continue
		}
		if carrier, err := os.ReadFile("/sys/class/net/" + name + "/carrier"); err == nil && strings.TrimSpace(string(carrier)) == "1" {
			return true
		}
	}
	return false
}

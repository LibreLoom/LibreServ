package wifi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeExecutable(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func TestNoopNewAutoAndSystemDetection(t *testing.T) {
	provider := New("wlan-test")
	wpa, ok := provider.(*WpaCli)
	if !ok || wpa.Interface != "wlan-test" {
		t.Fatalf("New returned %#v", provider)
	}
	noop := Noop{}
	if _, err := noop.Scan(); err == nil {
		t.Fatal("Noop.Scan should fail")
	}
	if err := noop.Connect("network", "password"); err == nil {
		t.Fatal("Noop.Connect should fail")
	}
	if err := noop.Forget(); err == nil {
		t.Fatal("Noop.Forget should fail")
	}
	status, err := noop.Status()
	if err != nil || status.Available || status.State != "unavailable" {
		t.Fatalf("Noop.Status = %+v, %v", status, err)
	}
	if Auto() == nil {
		t.Fatal("Auto returned nil")
	}
	_ = FindWirelessInterface()
	_ = EthernetConnected()
}

func TestParseScanResultsSkipsInvalidAndDetectsEncryption(t *testing.T) {
	out := "header\n" +
		"too\tfew\tcolumns\n" +
		"00\t2412\tnot-a-number\t[WEP][ESS]\tLegacy\n" +
		"01\t2412\t-20\t[WPA3-SAE][ESS]\tModern\n" +
		"02\t2412\t-30\t[ESS]\t   \n"
	networks := parseScanResults(out)
	if len(networks) != 2 {
		t.Fatalf("networks = %+v", networks)
	}
	if networks[0].SSID != "Legacy" || networks[0].Signal != 0 || !networks[0].Encrypted {
		t.Fatalf("legacy network = %+v", networks[0])
	}
	if networks[1].SSID != "Modern" || networks[1].Signal != -20 || !networks[1].Encrypted {
		t.Fatalf("modern network = %+v", networks[1])
	}
}

func TestWpaCliCommands(t *testing.T) {
	binDir := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "commands.log")
	t.Setenv("WPA_TEST_LOG", logPath)
	t.Setenv("PATH", binDir)
	writeExecutable(t, binDir, "wpa_cli", `
echo "$@" >> "$WPA_TEST_LOG"
case "$3" in
  add_network) echo "7" ;;
  status) printf "id=7\nssid=Home WiFi\nip_address=192.168.1.10\nwpa_state=COMPLETED\n" ;;
  scan_results) printf "header\n00:11\t2412\t-42\t[WPA2-PSK]\tHome WiFi\n" ;;
  *) echo "OK" ;;
esac
`)
	wpa := &WpaCli{Interface: "wlan0"}
	status, err := wpa.Status()
	if err != nil || !status.Available || !status.Connected ||
		status.SSID != "Home WiFi" || status.IPAddress != "192.168.1.10" {
		t.Fatalf("Status = %+v, %v", status, err)
	}
	networks, err := wpa.Scan()
	if err != nil || len(networks) != 1 || networks[0].Signal != -42 {
		t.Fatalf("Scan = %+v, %v", networks, err)
	}
	if err := wpa.Connect("Home WiFi", "secret"); err != nil {
		t.Fatalf("Connect secured: %v", err)
	}
	if err := wpa.Connect("Guest", ""); err != nil {
		t.Fatalf("Connect open: %v", err)
	}
	if err := wpa.Forget(); err != nil {
		t.Fatalf("Forget: %v", err)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read command log: %v", err)
	}
	commands := string(raw)
	for _, expected := range []string{
		"-i wlan0 scan_results",
		`-i wlan0 set_network 7 ssid "Home WiFi"`,
		`-i wlan0 set_network 7 psk "secret"`,
		"-i wlan0 set_network 7 key_mgmt NONE",
		"-i wlan0 remove_network 7",
		"-i wlan0 save_config",
	} {
		if !strings.Contains(commands, expected) {
			t.Errorf("command log missing %q:\n%s", expected, commands)
		}
	}
}

func TestWpaCliRunErrorsAndDisconnectedStatus(t *testing.T) {
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	wpa := &WpaCli{Interface: "wlan0"}
	if _, err := wpa.run("status"); err == nil || !strings.Contains(err.Error(), "could not reach") {
		t.Fatalf("missing command error = %v", err)
	}
	writeExecutable(t, binDir, "wpa_cli", `echo "supplicant unavailable" >&2; exit 2`)
	if _, err := wpa.run("status"); err == nil || !strings.Contains(err.Error(), "supplicant unavailable") {
		t.Fatalf("exit error = %v", err)
	}

	writeExecutable(t, binDir, "wpa_cli", `
if [ "$3" = "status" ]; then
  printf "wpa_state=DISCONNECTED\n"
else
  echo "OK"
fi
`)
	status, err := wpa.Status()
	if err != nil || status.Connected || status.State != "DISCONNECTED" {
		t.Fatalf("disconnected Status = %+v, %v", status, err)
	}
	if err := wpa.Connect("Home", "wrong"); err == nil || !strings.Contains(err.Error(), "password") {
		t.Fatalf("disconnected Connect error = %v", err)
	}
}

func TestSetupPortalStateValidationAndLifecycle(t *testing.T) {
	portal := NewSetupPortal("wlan0", t.TempDir())
	if portal.Running() {
		t.Fatal("new portal should not be running")
	}
	if got := portal.CachedScan(); got == nil || len(got) != 0 {
		t.Fatalf("empty cache = %#v", got)
	}
	input := []Network{{SSID: "Home", Signal: -30, Encrypted: true}}
	portal.SetCache(input)
	got := portal.CachedScan()
	if len(got) != 1 || got[0].SSID != "Home" {
		t.Fatalf("cache = %+v", got)
	}
	got[0].SSID = "mutated"
	if portal.CachedScan()[0].SSID != "Home" {
		t.Fatal("CachedScan did not return a copy")
	}
	SetActivePortal(portal)
	t.Cleanup(func() { SetActivePortal(nil) })
	if ActivePortal() != portal {
		t.Fatal("active portal was not retained")
	}

	invalid := NewSetupPortal("wlan0;rm", t.TempDir())
	if err := invalid.Start(); err == nil || !strings.Contains(err.Error(), "adapter name") {
		t.Fatalf("invalid interface error = %v", err)
	}
	parentFile := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(parentFile, []byte("x"), 0o600); err != nil {
		t.Fatalf("write parent file: %v", err)
	}
	badDir := NewSetupPortal("wlan0", filepath.Join(parentFile, "child"))
	if err := badDir.Start(); err == nil || !strings.Contains(err.Error(), "prepare") {
		t.Fatalf("bad run directory error = %v", err)
	}

	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	for _, command := range []string{"hostapd", "dnsmasq", "ip", "kill"} {
		writeExecutable(t, binDir, command, "exit 0")
	}
	if err := portal.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !portal.Running() {
		t.Fatal("portal should report running")
	}
	if err := portal.Start(); err != nil {
		t.Fatalf("idempotent Start: %v", err)
	}
	conf, err := os.ReadFile(filepath.Join(portal.runDir, "libreserv-setup-hostapd.conf"))
	if err != nil || !strings.Contains(string(conf), "ssid="+SetupSSID) {
		t.Fatalf("hostapd config = %q, %v", conf, err)
	}
	if err := os.WriteFile(portal.hostapdPIDPath(), []byte("123\n"), 0o600); err != nil {
		t.Fatalf("write hostapd pid: %v", err)
	}
	if err := os.WriteFile(portal.dnsmasqPIDPath(), []byte("456\n"), 0o600); err != nil {
		t.Fatalf("write dnsmasq pid: %v", err)
	}
	if err := portal.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if portal.Running() {
		t.Fatal("portal should report stopped")
	}
	if _, err := os.Stat(portal.hostapdPIDPath()); !os.IsNotExist(err) {
		t.Fatalf("hostapd PID file still exists: %v", err)
	}
	if err := portal.Stop(); err != nil {
		t.Fatalf("idempotent Stop: %v", err)
	}
}

func TestSetupPortalStartCommandFailuresAndPIDHelpers(t *testing.T) {
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)
	writeExecutable(t, binDir, "hostapd", `echo "radio busy"; exit 1`)
	portal := NewSetupPortal("wlan0", t.TempDir())
	if err := portal.Start(); err == nil || !strings.Contains(err.Error(), "radio busy") {
		t.Fatalf("hostapd failure = %v", err)
	}

	writeExecutable(t, binDir, "hostapd", "exit 0")
	writeExecutable(t, binDir, "ip", "exit 0")
	writeExecutable(t, binDir, "dnsmasq", `echo "address in use"; exit 1`)
	if err := portal.Start(); err == nil || !strings.Contains(err.Error(), "address in use") {
		t.Fatalf("dnsmasq failure = %v", err)
	}

	emptyPID := filepath.Join(portal.runDir, "empty.pid")
	if err := os.WriteFile(emptyPID, nil, 0o600); err != nil {
		t.Fatalf("write empty PID: %v", err)
	}
	if err := portal.killPIDFile(emptyPID); err != nil {
		t.Fatalf("empty killPIDFile: %v", err)
	}
	if err := portal.killPIDFile(filepath.Join(portal.runDir, "missing.pid")); err == nil {
		t.Fatal("expected missing PID file error")
	}
	if !strings.Contains(HostapdConfig("wlan0"), "channel=6") {
		t.Fatal("HostapdConfig missing channel")
	}
}

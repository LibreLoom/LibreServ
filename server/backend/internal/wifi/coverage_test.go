package wifi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installFakeWiFiCommands(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	wpa := `#!/bin/sh
printf '%s\n' "$*" >> "$WPA_LOG"
case "$*" in
  *"$WPA_FAIL"*) if [ -n "$WPA_FAIL" ]; then echo "forced failure" >&2; exit 2; fi ;;
esac
case "$*" in
  *scan_results) printf 'bssid / frequency / signal level / flags / ssid\n00:11:22:33:44:55\t2412\t-51\t[WPA2-PSK][ESS]\tTest Network\n' ;;
  *add_network) echo 7 ;;
  *status) printf 'id=7\nssid=Test Network\nip_address=192.0.2.4\nwpa_state=%s\n' "${WPA_STATE:-COMPLETED}" ;;
  *) echo OK ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "wpa_cli"), []byte(wpa), 0o755); err != nil {
		t.Fatalf("write wpa_cli: %v", err)
	}
	command := `#!/bin/sh
if [ "$FAIL_COMMAND" = "$(basename "$0")" ]; then
  echo "forced command failure" >&2
  exit 2
fi
exit 0
`
	for _, name := range []string{"hostapd", "dnsmasq", "ip"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(command), 0o755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("WPA_LOG", filepath.Join(dir, "wpa.log"))
	return dir
}

func TestNoopNewAutoAndHostInspection(t *testing.T) {
	noop := Noop{}
	if _, err := noop.Scan(); err == nil {
		t.Fatal("Noop.Scan should fail")
	}
	if err := noop.Connect("ssid", "password"); err == nil {
		t.Fatal("Noop.Connect should fail")
	}
	if err := noop.Forget(); err == nil {
		t.Fatal("Noop.Forget should fail")
	}
	status, err := noop.Status()
	if err != nil || status.Available || status.State != "unavailable" {
		t.Fatalf("Noop.Status = %+v, %v", status, err)
	}
	if provider, ok := New("wlan9").(*WpaCli); !ok || provider.Interface != "wlan9" {
		t.Fatalf("New returned %#v", provider)
	}
	if Auto() == nil {
		t.Fatal("Auto returned nil")
	}
	_ = FindWirelessInterface()
	_ = EthernetConnected()
}

func TestWpaCliScanStatusConnectAndForget(t *testing.T) {
	installFakeWiFiCommands(t)
	wpa := &WpaCli{Interface: "wlan0"}

	nets, err := wpa.Scan()
	if err != nil || len(nets) != 1 || nets[0].SSID != "Test Network" || !nets[0].Encrypted {
		t.Fatalf("Scan = %+v, %v", nets, err)
	}
	status, err := wpa.Status()
	if err != nil || !status.Available || !status.Connected || status.SSID != "Test Network" ||
		status.IPAddress != "192.0.2.4" || status.State != "COMPLETED" {
		t.Fatalf("Status = %+v, %v", status, err)
	}
	if err := wpa.Connect("Test Network", "secret"); err != nil {
		t.Fatalf("Connect secured: %v", err)
	}
	if err := wpa.Connect("Open Network", ""); err != nil {
		t.Fatalf("Connect open: %v", err)
	}
	if err := wpa.Forget(); err != nil {
		t.Fatalf("Forget: %v", err)
	}

	raw, err := os.ReadFile(os.Getenv("WPA_LOG"))
	if err != nil {
		t.Fatalf("read command log: %v", err)
	}
	log := string(raw)
	for _, want := range []string{
		"-i wlan0 scan",
		"-i wlan0 scan_results",
		`set_network 7 ssid "Test Network"`,
		`set_network 7 psk "secret"`,
		"set_network 7 key_mgmt NONE",
		"enable_network 7",
		"select_network 7",
		"remove_network 7",
		"save_config",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("command log missing %q:\n%s", want, log)
		}
	}
}

func TestWpaCliErrorsAndParsing(t *testing.T) {
	dir := installFakeWiFiCommands(t)
	wpa := &WpaCli{Interface: "wlan0"}

	t.Setenv("WPA_FAIL", "status")
	status, err := wpa.Status()
	if err == nil || !strings.Contains(err.Error(), "forced failure") ||
		!status.Available || status.State != "error" {
		t.Fatalf("failed status = %+v, %v", status, err)
	}
	if err := wpa.Forget(); err != nil {
		t.Fatalf("Forget ignores status error: %v", err)
	}
	t.Setenv("WPA_FAIL", "add_network")
	if err := wpa.Connect("x", "y"); err == nil {
		t.Fatal("expected add network failure")
	}
	t.Setenv("WPA_FAIL", "set_network")
	if err := wpa.Connect("x", "y"); err == nil {
		t.Fatal("expected set network failure")
	}

	t.Setenv("PATH", filepath.Join(dir, "missing"))
	if _, err := wpa.run("status"); err == nil || !strings.Contains(err.Error(), "could not reach") {
		t.Fatalf("missing tool error = %v", err)
	}

	input := "header\n" +
		"too\tfew\tcolumns\n" +
		"00\t2412\tnot-a-number\t[WEP]\tLegacy\n" +
		"11\t2412\t-70\t[ESS]\t   \n" +
		"22\t2412\t-30\t[WPA]\tSecure\n"
	nets := parseScanResults(input)
	if len(nets) != 2 || nets[0].Signal != 0 || !nets[0].Encrypted || nets[1].SSID != "Secure" {
		t.Fatalf("parsed networks = %+v", nets)
	}
}

func TestWpaCliConnectReportsUnassociated(t *testing.T) {
	installFakeWiFiCommands(t)
	t.Setenv("WPA_STATE", "DISCONNECTED")
	err := (&WpaCli{Interface: "wlan0"}).Connect("Test Network", "wrong")
	if err == nil || !strings.Contains(err.Error(), "password") {
		t.Fatalf("connection error = %v", err)
	}
}

func TestSetupPortalStateAndLifecycle(t *testing.T) {
	installFakeWiFiCommands(t)
	runDir := t.TempDir()
	portal := NewSetupPortal("wlan0", runDir)

	if portal.Running() {
		t.Fatal("new portal should not run")
	}
	if got := portal.CachedScan(); len(got) != 0 || got == nil {
		t.Fatalf("empty cache = %#v", got)
	}
	input := []Network{{SSID: "one", Signal: -20}}
	portal.SetCache(input)
	input[0].SSID = "changed"
	got := portal.CachedScan()
	got[0].SSID = "also changed"
	if portal.CachedScan()[0].SSID != "one" {
		t.Fatal("cache was not copied")
	}

	SetActivePortal(portal)
	if ActivePortal() != portal {
		t.Fatal("active portal mismatch")
	}
	SetActivePortal(nil)
	if ActivePortal() != nil {
		t.Fatal("active portal was not cleared")
	}

	if err := portal.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !portal.Running() {
		t.Fatal("portal did not start")
	}
	if err := portal.Start(); err != nil {
		t.Fatalf("idempotent Start: %v", err)
	}
	conf, err := os.ReadFile(filepath.Join(runDir, "libreserv-setup-hostapd.conf"))
	if err != nil || string(conf) != HostapdConfig("wlan0") {
		t.Fatalf("hostapd config = %q, %v", conf, err)
	}
	if err := portal.Stop(); err != nil || portal.Running() {
		t.Fatalf("Stop = %v, running %v", err, portal.Running())
	}
	if err := portal.Stop(); err != nil {
		t.Fatalf("idempotent Stop: %v", err)
	}
	if portal.hostapdPIDPath() == portal.dnsmasqPIDPath() {
		t.Fatal("PID paths should differ")
	}
}

func TestSetupPortalStartErrors(t *testing.T) {
	installFakeWiFiCommands(t)
	if err := NewSetupPortal("bad iface!", t.TempDir()).Start(); err == nil {
		t.Fatal("expected invalid interface error")
	}

	parent := t.TempDir()
	file := filepath.Join(parent, "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NewSetupPortal("wlan0", filepath.Join(file, "child")).Start(); err == nil ||
		!strings.Contains(err.Error(), "prepare") {
		t.Fatalf("run directory error = %v", err)
	}

	t.Setenv("FAIL_COMMAND", "hostapd")
	if err := NewSetupPortal("wlan0", t.TempDir()).Start(); err == nil ||
		!strings.Contains(err.Error(), "start the setup network") {
		t.Fatalf("hostapd error = %v", err)
	}
	t.Setenv("FAIL_COMMAND", "dnsmasq")
	if err := NewSetupPortal("wlan0", t.TempDir()).Start(); err == nil ||
		!strings.Contains(err.Error(), "start the setup network") {
		t.Fatalf("dnsmasq error = %v", err)
	}
}

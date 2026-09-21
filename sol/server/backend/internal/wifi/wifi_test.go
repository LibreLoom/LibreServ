package wifi

import (
	"strings"
	"testing"
)

func TestParseScanResults(t *testing.T) {
	out := "bssid / frequency / signal level / flags / ssid\n" +
		"00:11:22:33:44:55\t2412\t-44\t[WPA2-PSK-CCMP][ESS]\tHome WiFi\n" +
		"aa:bb:cc:dd:ee:ff\t2412\t-80\t[ESS]\tCoffee Shop\n"
	networks := parseScanResults(out)
	if len(networks) != 2 {
		t.Fatalf("got %d networks, want 2", len(networks))
	}
	if networks[0].SSID != "Home WiFi" || !networks[0].Encrypted {
		t.Fatalf("bad first network: %+v", networks[0])
	}
	if networks[1].SSID != "Coffee Shop" || networks[1].Encrypted {
		t.Fatalf("bad second network: %+v", networks[1])
	}
}

func TestHostapdConfigIsOpenLibreServSetup(t *testing.T) {
	cfg := HostapdConfig("wlan0")
	if !strings.Contains(cfg, "interface=wlan0") {
		t.Fatalf("missing interface: %s", cfg)
	}
	if !strings.Contains(cfg, "ssid="+SetupSSID) {
		t.Fatalf("missing ssid: %s", cfg)
	}
	if strings.Contains(cfg, "wpa_passphrase") {
		t.Fatal("setup hotspot must be open so a phone can join without a password")
	}
}

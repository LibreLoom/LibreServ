package wifi

import (
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

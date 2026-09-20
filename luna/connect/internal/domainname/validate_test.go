package domainname

import "testing"

func TestValidate(t *testing.T) {
	if Validate("ab") != "" {
		// too short
	} else {
		t.Fatal("short name should fail")
	}
	if msg := Validate("photos"); msg != "" {
		t.Fatalf("photos: %s", msg)
	}
	if Validate("www") == "" {
		t.Fatal("www should be reserved")
	}
	if Validate("libreserv") == "" {
		t.Fatal("libreserv should be reserved")
	}
	if Validate("libreloom") == "" {
		t.Fatal("libreloom should be reserved")
	}
	if Validate("Bad Name") == "" {
		t.Fatal("spaces should fail")
	}
}

func TestHostname(t *testing.T) {
	got := Hostname("Photos", "luna.servers.libreloom.org")
	if got != "photos.luna.servers.libreloom.org" {
		t.Fatalf("got %s", got)
	}
	if Hostname("evil.example", "luna.servers.libreloom.org") != "" {
		t.Fatal("multi-label subdomain must be rejected")
	}
	if Hostname("photos", "") != "" {
		t.Fatal("empty zone must be rejected")
	}
	if Hostname("", "luna.servers.libreloom.org") != "" {
		t.Fatal("empty subdomain must be rejected")
	}
	if Hostname("photos", "luna servers") != "" {
		t.Fatal("zone with spaces must be rejected")
	}
	if Hostname("phots/x", "luna.servers.libreloom.org") != "" {
		t.Fatal("subdomain with slash must be rejected")
	}
}

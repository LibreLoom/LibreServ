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
	if Validate("Bad Name") == "" {
		t.Fatal("spaces should fail")
	}
}

func TestHostname(t *testing.T) {
	got := Hostname("Photos", "luna.servers.libreloom.org")
	if got != "photos.luna.servers.libreloom.org" {
		t.Fatalf("got %s", got)
	}
}

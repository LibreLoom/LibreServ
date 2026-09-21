package domainname

import "testing"

func TestReservedLunaAndFree(t *testing.T) {
	for _, name := range []string{"luna", "Luna", " free ", "FREE"} {
		if !IsReserved(name) {
			t.Fatalf("%q should be reserved", name)
		}
		if _, msg := Validate(name); msg == "" {
			t.Fatalf("Validate(%q) should fail", name)
		}
	}
}

func TestValidateOK(t *testing.T) {
	got, msg := Validate("Kitchen-NAS")
	if msg != "" {
		t.Fatal(msg)
	}
	if got != "kitchen-nas" {
		t.Fatalf("got %q", got)
	}
}

func TestBrandOwned(t *testing.T) {
	owned := []string{
		"libreloom.org",
		"Luna.servers.libreloom.org",
		"foo.libreloom.org",
		"connect.serv.libreloom.org.",
		"libreserv.org",
		"www.libreserv.org",
		"shop.libreserv.org.",
	}
	for _, d := range owned {
		if !IsBrandOwned(d) {
			t.Fatalf("%q should be brand-owned", d)
		}
	}
	for _, d := range []string{"example.com", "myluna.org", "servers.libreloom.com", "notlibreserv.org"} {
		if IsBrandOwned(d) {
			t.Fatalf("%q should not be treated as brand-owned", d)
		}
	}
}

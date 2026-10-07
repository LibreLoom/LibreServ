package app

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

func TestDefaultClientsSplitAPIAndTransfer(t *testing.T) {
	a, err := New(Config{Repo: t.TempDir(), CacheDir: t.TempDir(), NoKeyring: true})
	must(t, err)
	if a.cfg.HTTP.Timeout == 0 || a.cfg.HTTP.Timeout > 2*60*1e9 {
		t.Fatalf("API client timeout %s should be short", a.cfg.HTTP.Timeout)
	}
	if a.cfg.Transfer == nil || a.cfg.Transfer.Timeout != 0 {
		t.Fatalf("transfer client must have no overall timeout: %+v", a.cfg.Transfer)
	}
	reg, forge := a.registry(&secrets.ForgejoCreds{Token: "x"})
	if reg.HTTP != a.cfg.Transfer || forge.HTTP != a.cfg.HTTP {
		t.Fatal("registry must use the transfer client and Forgejo the API client")
	}
}

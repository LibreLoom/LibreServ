package secrets

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/99designs/keyring"
)

func TestKeyringFileBackend(t *testing.T) {
	d := t.TempDir()
	st, err := NewKeyringStore(KeyringConfig{
		Service: "libreserv-release-test", FileDir: filepath.Join(d, "kr"),
		Backends:   []keyring.BackendType{keyring.FileBackend},
		Passphrase: func(string) (string, error) { return "file-pass", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Get(SlotForgejoToken); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	e := newTestEnv(t)
	m := e.manager(func(o *Options) { o.Store = st })
	if err := m.SetValue(SlotForgejoToken, "tok"); err != nil {
		t.Fatal(err)
	}
	if v, _ := st.Get(SlotForgejoToken); v != "tok" {
		t.Fatal("not stored")
	}
	if !m.Slots()[0].Set {
		t.Fatal("slot should report set")
	}
	if !e.red.has("tok") {
		t.Fatal("not redacted")
	}
	if err := m.Forget(SlotForgejoToken); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Get(SlotForgejoToken); err != ErrNotFound {
		t.Fatal("not forgotten")
	}
	if err := m.SetValue("bogus", "x"); err == nil {
		t.Fatal("unknown slot accepted")
	}
}

func TestProtonDisabledByDefaultAndPlumbing(t *testing.T) {
	e := newTestEnv(t)
	e.run = func(_ context.Context, _ string, _ []string, name string, args ...string) ([]byte, error) {
		if name == "pass-cli" && args[0] == "item" {
			return []byte("proton-pw\n"), nil
		}
		return nil, nil
	}
	p := NewProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: "pass://V/I/f"}}, e.run)
	vals, err := p.Lookup(context.Background(), SlotForgejoToken)
	if err != nil || len(vals) != 1 || vals[0] != "proton-pw" {
		t.Fatalf("%v %v", vals, err)
	}
	if v, _ := p.Lookup(context.Background(), SlotAndroidAlias); v != nil {
		t.Fatal("unmapped slot should be empty")
	}
	if NewProton(ProtonConfig{}, e.run).Enabled() {
		t.Fatal("must be off unless configured")
	}
}

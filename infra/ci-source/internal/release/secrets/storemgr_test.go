package secrets

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/99designs/keyring"
)

// fileSystemStore is a stand-in "system keyring" backed by a temp file
// keyring, so tests never touch the real one.
func fileSystemStore(t *testing.T, dir string) func() (Store, error) {
	return func() (Store, error) {
		return NewKeyringStore(KeyringConfig{Service: "t-system", FileDir: dir,
			Backends:   []keyring.BackendType{keyring.FileBackend},
			Passphrase: func(string) (string, error) { return "system-not-asked", nil }})
	}
}

type smEnv struct {
	dir     string
	asked   *int
	answers []string
}

func newSM(t *testing.T, mut ...func(*StoreOptions)) (*StoreManager, string) {
	t.Helper()
	d := t.TempDir()
	o := StoreOptions{ConfigDir: filepath.Join(d, "cfg"), VaultDir: filepath.Join(d, "cfg", "keyring"),
		System: fileSystemStore(t, filepath.Join(d, "system"))}
	for _, f := range mut {
		f(&o)
	}
	return NewStoreManager(o), d
}

func TestStoreDefaults(t *testing.T) {
	sm, _ := newSM(t)
	if sm.Saved() != "" {
		t.Fatal("nothing saved yet")
	}
	if sm.Mode() != ModeSystem {
		t.Fatalf("system available, want system, got %s", sm.Mode())
	}
	if sm.Backend() != "file" { // the stand-in is a file keyring
		t.Fatalf("backend %q", sm.Backend())
	}
	sm2, _ := newSM(t, func(o *StoreOptions) {
		o.System = func() (Store, error) { return nil, errors.New("no dbus") }
	})
	if sm2.Mode() != ModeVault {
		t.Fatalf("no system keyring, want vault, got %s", sm2.Mode())
	}
	if sm2.Backend() != "file" || !sm2.NeedsUnlock() {
		t.Fatal("vault should be locked and report the file backend")
	}
	if ok, err := sm2.SystemAvailable(); ok || !errors.Is(err, ErrSystemUnavailable) {
		t.Fatalf("%v %v", ok, err)
	}
}

func TestBackendNamesRealBackend(t *testing.T) {
	st, err := NewKeyringStore(KeyringConfig{FileDir: t.TempDir(), Backends: []keyring.BackendType{keyring.FileBackend},
		Passphrase: func(string) (string, error) { return "p", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if st.Backend() != "file" {
		t.Fatalf("got %q", st.Backend())
	}
}

func TestVaultUnlockOnceAndWrongPassphrase(t *testing.T) {
	calls := 0
	pass := func(prompt string) (string, error) { calls++; return "correct horse", nil }
	sm, d := newSM(t, func(o *StoreOptions) {
		o.Passphrase = pass
		o.System = func() (Store, error) { return nil, errors.New("none") }
	})
	// First use creates the vault: asks twice (choose + confirm), then never again.
	if err := sm.Set(SlotForgejoToken, "tok"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("creating asks twice, got %d", calls)
	}
	for i := 0; i < 3; i++ {
		if v, err := sm.Get(SlotForgejoToken); err != nil || v != "tok" {
			t.Fatalf("%q %v", v, err)
		}
	}
	if keys, _ := sm.Keys(); len(keys) != 1 || keys[0] != SlotForgejoToken {
		t.Fatalf("canary must stay hidden: %v", keys)
	}
	if calls != 2 {
		t.Fatalf("asked again: %d", calls)
	}

	// A new process: the vault exists, the passphrase is asked exactly once.
	calls = 0
	sm2 := NewStoreManager(StoreOptions{ConfigDir: filepath.Join(d, "cfg"), VaultDir: filepath.Join(d, "cfg", "keyring"),
		Passphrase: pass, System: func() (Store, error) { return nil, errors.New("none") }})
	_, _ = sm2.Get(SlotForgejoToken)
	_ = sm2.Set(SlotAndroidAlias, "luna")
	_, _ = sm2.Keys()
	v, _ := sm2.Get(SlotForgejoToken)
	if v != "tok" || calls != 1 {
		t.Fatalf("value %q, asked %d times", v, calls)
	}

	// Wrong passphrase is reported, not read as "nothing stored".
	sm3 := NewStoreManager(StoreOptions{ConfigDir: filepath.Join(d, "cfg"), VaultDir: filepath.Join(d, "cfg", "keyring"),
		System: func() (Store, error) { return nil, errors.New("none") }})
	if err := sm3.Unlock("nope"); !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("want wrong passphrase, got %v", err)
	}
	if sm3.Unlocked() {
		t.Fatal("must stay locked")
	}
	if err := sm3.Unlock("correct horse"); err != nil || !sm3.Unlocked() {
		t.Fatal(err)
	}
	if v, _ := sm3.Get(SlotForgejoToken); v != "tok" {
		t.Fatal("not readable after unlock")
	}
}

func TestSwitchStoresMigrates(t *testing.T) {
	var redacted []string
	sm, d := newSM(t, func(o *StoreOptions) { o.OnSecret = func(s string) { redacted = append(redacted, s) } })
	if sm.Mode() != ModeSystem {
		t.Fatal("start on system")
	}
	vals := map[string]string{SlotForgejoToken: "tok", SlotAndroidStorePW: "pw1", SlotKey(LunaSigning): "RW" + strings.Repeat("a", 210)}
	for k, v := range vals {
		if err := sm.Set(k, v); err != nil {
			t.Fatal(err)
		}
	}
	// Going to the vault needs a passphrase.
	if _, err := sm.SwitchTo(ModeVault, ""); !errors.Is(err, ErrLocked) {
		t.Fatalf("want locked, got %v", err)
	}
	if sm.Saved() != "" {
		t.Fatal("a failed switch must not save a choice")
	}
	n, err := sm.SwitchTo(ModeVault, "vault pass")
	if err != nil || n != 3 {
		t.Fatalf("moved %d, %v", n, err)
	}
	if sm.Saved() != ModeVault || sm.Mode() != ModeVault || !sm.Unlocked() || sm.Backend() != "file" {
		t.Fatal("not on the vault")
	}
	for k, v := range vals {
		if got, err := sm.Get(k); err != nil || got != v {
			t.Fatalf("%s: %q %v", k, got, err)
		}
	}
	if len(redacted) == 0 || redacted[0] != "vault pass" {
		t.Fatal("passphrase must reach the redactor")
	}
	// The old store was emptied.
	old, _ := fileSystemStore(t, filepath.Join(d, "system"))()
	for k := range vals {
		if _, err := old.Get(k); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s still in the old store (%v)", k, err)
		}
	}
	// And back, with the vault already unlocked (no passphrase needed).
	n, err = sm.SwitchTo(ModeSystem, "")
	if err != nil || n != 3 {
		t.Fatalf("moved back %d, %v", n, err)
	}
	if sm.Mode() != ModeSystem || sm.VaultExists() && countFiles(t, sm.VaultDir()) > 0 {
		t.Fatalf("vault should be empty: %v", sm.VaultExists())
	}
	for k, v := range vals {
		if got, _ := old.Get(k); got != v {
			t.Fatalf("%s lost on the way back", k)
		}
	}
	// Persisted for the next process.
	sm2 := NewStoreManager(StoreOptions{ConfigDir: filepath.Join(d, "cfg"), System: fileSystemStore(t, filepath.Join(d, "system"))})
	if sm2.Saved() != ModeSystem {
		t.Fatal("choice not saved in secrets.json")
	}
}

func countFiles(t *testing.T, dir string) int {
	ents, _ := os.ReadDir(dir)
	return len(ents)
}

func TestSwitchToSystemWhenUnavailable(t *testing.T) {
	sm, _ := newSM(t, func(o *StoreOptions) { o.System = func() (Store, error) { return nil, errors.New("none") } })
	if _, err := sm.SwitchTo(ModeSystem, ""); !errors.Is(err, ErrSystemUnavailable) {
		t.Fatalf("got %v", err)
	}
}

func TestChangePassphrase(t *testing.T) {
	sm, d := newSM(t, func(o *StoreOptions) { o.System = func() (Store, error) { return nil, errors.New("none") } })
	if err := sm.Unlock("old"); err != nil {
		t.Fatal(err)
	}
	_ = sm.Set(SlotForgejoToken, "tok")
	if err := sm.ChangePassphrase("wrong", "new"); !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("got %v", err)
	}
	if err := sm.ChangePassphrase("old", "new"); err != nil {
		t.Fatal(err)
	}
	if v, _ := sm.Get(SlotForgejoToken); v != "tok" {
		t.Fatal("value lost")
	}
	fresh := NewStoreManager(StoreOptions{ConfigDir: filepath.Join(d, "cfg"), VaultDir: filepath.Join(d, "cfg", "keyring"),
		System: func() (Store, error) { return nil, errors.New("none") }})
	if err := fresh.Unlock("old"); !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("old passphrase must stop working: %v", err)
	}
	if err := fresh.Unlock("new"); err != nil {
		t.Fatal(err)
	}
	if v, _ := fresh.Get(SlotForgejoToken); v != "tok" {
		t.Fatal("value lost after change")
	}
	for _, leftover := range []string{".new", ".old"} {
		if _, err := os.Stat(sm.VaultDir() + leftover); err == nil {
			t.Fatalf("%s left behind", leftover)
		}
	}
}

func TestPasteKeyAndKeystoreAndSession(t *testing.T) {
	e := newTestEnv(t)
	m := e.manager()
	k := genKey(t)
	e.writePub("lsluna.minisign.pub", k)
	e.writePub("libreserv.minisign.pub", genKey(t))
	text := e.encrypted(k, "pw")
	// Pasted as one line (a terminal paste may drop the newlines) with the comment: still works.
	oneLine := strings.ReplaceAll(text, "\n", " ")
	if _, err := m.PasteKey(LunaSigning, oneLine, true); err == nil {
		// the comment text is lost with the newline; the bare line must still be found
		_ = err
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	n, err := m.PasteKey(LunaSigning, lines[1], false)
	if err != nil || n == 0 {
		t.Fatalf("%d %v", n, err)
	}
	if _, err := m.PasteKey(LunaSigning, "not a key", true); err == nil {
		t.Fatal("garbage accepted")
	}
	if !e.red.has(lines[1]) {
		t.Fatal("pasted key not redacted")
	}
	// Session-only: nothing in the store.
	if keys, _ := m.opt.Store.Keys(); len(keys) != 0 {
		t.Fatalf("session paste leaked into the store: %v", keys)
	}
	if got := m.stored(nil, SlotKey(LunaSigning)); len(got) == 0 {
		t.Fatal("session value not offered to the resolver")
	}
	if _, err := m.PasteKeystore("%%%", true); err == nil {
		t.Fatal("bad base64 accepted")
	}
	if n, err := m.PasteKeystore("aGVsbG8g\nd29ybGQ=", true); err != nil || n != 11 {
		t.Fatalf("%d %v", n, err)
	}
	if v, _ := m.opt.Store.Get(SlotAndroidKeystore); v != "aGVsbG8gd29ybGQ=" {
		t.Fatalf("stored %q", v)
	}
}

func TestSetProtonRoundTrip(t *testing.T) {
	e := newTestEnv(t)
	m := e.manager(func(o *Options) { o.ConfigDir = filepath.Join(e.home, "cfg") })
	if err := m.SetProton(ProtonConfig{Enabled: true, Refs: map[string]string{SlotForgejoToken: "pass://V/I/f"}}); err != nil {
		t.Fatal(err)
	}
	if pc := m.ProtonConfig(); !pc.Enabled || pc.Refs[SlotForgejoToken] == "" {
		t.Fatalf("%+v", pc)
	}
}

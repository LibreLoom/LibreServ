package secrets

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupKeys(t *testing.T) (*testEnv, testKey, testKey, testKey) {
	e := newTestEnv(t)
	lib, luna, other := genKey(t), genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", luna)
	// Names deliberately swapped: contents decide, not names.
	e.write(filepath.Join(e.home, ".minisign", "sol.key"), e.encrypted(luna, "pw-luna"))
	e.write(filepath.Join(e.home, ".minisign", "luna.key"), e.encrypted(lib, "pw-lib"))
	e.write(filepath.Join(e.home, ".minisign", "old.key"), e.encrypted(other, "pw-old"))
	return e, lib, luna, other
}

func TestSigningPairsByContentsAndCaches(t *testing.T) {
	e, lib, luna, _ := setupKeys(t)
	// The release passphrase opens the Sol key; the Luna key has its own.
	e.pr = passphrases("pw-lib", "pw-luna")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if err := m.Unlock(ctx, SolSigning, LunaSigning); err != nil {
		t.Fatal(err)
	}
	sg, st := m.Signing(ctx, SolSigning)
	if st.State != Proven || sg == nil || sg.KeyID != keyIDString(lib.pub.ID()) {
		t.Fatalf("sol: %+v", st)
	}
	sl, st := m.Signing(ctx, LunaSigning)
	if st.State != Proven || sl.KeyID != keyIDString(luna.pub.ID()) {
		t.Fatalf("luna: %+v", st)
	}
	msg := []byte("hello")
	if !sg.Verify(msg, sg.Sign(msg)) {
		t.Fatal("signature does not verify")
	}
	// old.key opens with nothing typed: reported, not a release key.
	var sawOld bool
	for _, c := range st.Candidates {
		if strings.Contains(c.Where, "old.key") {
			sawOld = true
		}
	}
	if !sawOld {
		t.Fatalf("old.key missing from report: %+v", st.Candidates)
	}
	// Cache: non-secret facts only (which file holds which key ID).
	b, err := os.ReadFile(filepath.Join(e.home, ".cache", "libreserv-release", "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"pw-luna", "pw-lib"} {
		if strings.Contains(string(b), secret) {
			t.Fatal("cache holds a password")
		}
	}
	if !strings.Contains(string(b), keyIDString(lib.pub.ID())) {
		t.Fatalf("cache lacks the key ID: %s", b)
	}
	// Nothing typed was stored anywhere.
	keys, _ := m.opt.Store.Keys()
	if len(keys) != 0 {
		t.Fatalf("store holds %v", keys)
	}
}

func TestSigningLockedUntilUnlock(t *testing.T) {
	e, _, _, _ := setupKeys(t)
	e.pr = passphrases("pw-lib")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	// Looking (secrets list, doctor, preflight) never asks.
	st := m.Status(ctx, SolSigning)
	if st.State != Locked || !st.NeedsPassword {
		t.Fatalf("want locked: %+v", st)
	}
	if len(e.pr.asked) != 0 {
		t.Fatalf("a status check asked: %+v", e.pr.asked)
	}
	if sg, _ := m.Signing(ctx, SolSigning); sg != nil {
		t.Fatal("a locked key signed")
	}
	// A cut unlocks: one question, a secret one, about the release passphrase.
	if err := m.Unlock(ctx, SolSigning); err != nil {
		t.Fatal(err)
	}
	qs := e.pr.passQuestions()
	if len(qs) != 1 || !qs[0].Secret || !strings.Contains(qs[0].Label, "Release passphrase") {
		t.Fatalf("questions: %+v", e.pr.asked)
	}
	if st := m.Status(ctx, SolSigning); st.State != Proven {
		t.Fatalf("after unlock: %+v", st)
	}
}

func TestUnlockOnePassphraseOpensEveryKeyAndWipe(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", luna)
	e.write(filepath.Join(e.home, ".minisign", "a.key"), e.encrypted(lib, "one passphrase"))
	e.write(filepath.Join(e.home, ".minisign", "b.key"), e.encrypted(luna, "one passphrase"))
	typed := []byte("one passphrase")
	e.pr = &fakePrompter{passes: [][]byte{typed}}
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if err := m.Unlock(ctx, SolSigning, LunaSigning); err != nil {
		t.Fatal(err)
	}
	if n := len(e.pr.passQuestions()); n != 1 {
		t.Fatalf("asked %d times, want once: %+v", n, e.pr.asked)
	}
	sg, _ := m.Signing(ctx, SolSigning)
	sl, _ := m.Signing(ctx, LunaSigning)
	if sg == nil || sl == nil {
		t.Fatal("not both unlocked")
	}

	m.Wipe()
	if string(typed) == "one passphrase" || strings.Trim(string(typed), "\x00") != "" {
		t.Fatalf("the typed passphrase was not zeroed: %q", typed)
	}
	msg := []byte("x")
	if sg.Verify(msg, sg.Sign(msg)) || sl.Verify(msg, sl.Sign(msg)) {
		t.Fatal("a wiped key still signs")
	}
	if len(m.passes) != 0 {
		t.Fatal("passphrases kept after Wipe")
	}
	// The next cut asks again.
	if st := m.Status(ctx, SolSigning); st.State != Locked {
		t.Fatalf("after wipe: %+v", st)
	}
}

func TestUnlockAsksAgainNamingTheKey(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", luna)
	e.write(filepath.Join(e.home, ".minisign", "sol.key"), e.encrypted(lib, "release"))
	e.write(filepath.Join(e.home, ".minisign", "luna.key"), e.encrypted(luna, "older"))
	// Release passphrase, then a wrong try, then the Luna key's own.
	e.pr = passphrases("release", "wrong", "older")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if err := m.Unlock(ctx, SolSigning, LunaSigning); err != nil {
		t.Fatal(err)
	}
	qs := e.pr.passQuestions()
	if len(qs) != 3 {
		t.Fatalf("want 3 questions, got %+v", qs)
	}
	if !strings.Contains(qs[1].Label, "does not open") || !strings.Contains(qs[1].Label, "luna.key") {
		t.Fatalf("the second question must name the key file: %q", qs[1].Label)
	}
	if !strings.Contains(qs[2].Label, "either") {
		t.Fatalf("a retry must say the last one failed: %q", qs[2].Label)
	}
	for _, id := range []ID{SolSigning, LunaSigning} {
		if st := m.Status(ctx, id); st.State != Proven {
			t.Fatalf("%s: %+v", id, st)
		}
	}
}

func TestUnlockWithoutTerminalFails(t *testing.T) {
	e, _, _, _ := setupKeys(t)
	m := e.manager(func(o *Options) { o.NoHomeScan = true }) // no Prompter: stdin is not a terminal
	err := m.Unlock(context.Background(), SolSigning)
	if err == nil || !strings.Contains(err.Error(), "terminal") {
		t.Fatalf("want a plain terminal error, got %v", err)
	}
}

func TestSigningPasswordsNeverFromEnvOrStore(t *testing.T) {
	e, _, _, _ := setupKeys(t)
	// The variables earlier versions read, and an old saved password.
	for _, k := range []string{"MINISIGN_PASSPHRASE", "SOL_RELEASE_MINISIG_PW", "LUNA_RELEASE_MINISIG_PW"} {
		e.env[k] = "pw-lib"
		e.env[k+"_B64"] = "cHctbGli"
	}
	store := NewMemStore()
	store.Set("minisign-password", "pw-lib")
	m := e.manager(func(o *Options) { o.NoHomeScan = true; o.Store = store })
	ctx := context.Background()
	if st := m.Status(ctx, SolSigning); st.State != Locked {
		t.Fatalf("a password came from env or the store: %+v", st)
	}
	// Saving one is refused, for every old password slot and the passphrase.
	for _, slot := range append([]string{ReleasePassphraseSlot}, oldPasswordSlots...) {
		if err := m.SetValue(slot, "x"); !errors.Is(err, ErrPasswordNotSaved) {
			t.Errorf("SetValue(%s) = %v", slot, err)
		}
		if err := m.SetValueOpt(slot, "x", true); !errors.Is(err, ErrPasswordNotSaved) {
			t.Errorf("SetValueOpt(%s) = %v", slot, err)
		}
		if CanRemember(slot) {
			t.Errorf("%s offered for remembering", slot)
		}
	}
	// The old saved one is listed so it can be forgotten.
	var listed bool
	for _, s := range m.Slots() {
		if s.Slot == "minisign-password" && s.Old && s.Set {
			listed = true
		}
	}
	if !listed {
		t.Fatalf("old password not listed: %+v", m.Slots())
	}
	if err := m.Forget("minisign-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("minisign-password"); err == nil {
		t.Fatal("not forgotten")
	}
}

func TestSigningMissingAndScan(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", luna)
	e.write(filepath.Join(e.home, "Documents", "stuff", "backup.txt"), e.encrypted(lib, "pw"))

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	if st := m.Status(context.Background(), SolSigning); st.State != Missing {
		t.Fatalf("without scan: %+v", st)
	}
	e.pr = passphrases("pw")
	m = e.manager()
	if st := m.Status(context.Background(), SolSigning); st.State != Locked {
		t.Fatalf("home scan should find it by header: %+v", st)
	}
	if err := m.Unlock(context.Background(), SolSigning); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(context.Background(), LunaSigning); st.State != Missing {
		t.Fatalf("luna: %+v", st)
	}
}

func TestSigningEnvFormsAndAddPath(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", luna)
	// Luna key as pasted text; sol key in a user-added folder.
	e.env["LUNA_RELEASE_MINISIG_PK"] = e.encrypted(luna, "p1")
	extra := filepath.Join(e.home, "vault")
	e.write(filepath.Join(extra, "k", "x.bin"), e.encrypted(lib, "p1"))
	e.pr = passphrases("p1")

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if err := m.Unlock(ctx, LunaSigning); err != nil {
		t.Fatalf("luna from env: %v", err)
	}
	if st := m.Status(ctx, SolSigning); st.State != Missing {
		t.Fatalf("before AddPath: %+v", st)
	}
	if err := m.AddPath(extra); err != nil {
		t.Fatal(err)
	}
	// The passphrase typed this run opens it without asking again.
	if err := m.Unlock(ctx, SolSigning); err != nil {
		t.Fatalf("after AddPath: %v", err)
	}
	if n := len(e.pr.passQuestions()); n != 1 {
		t.Fatalf("asked %d times", n)
	}
	if got := m.Paths(); len(got) != 1 || got[0] != extra {
		t.Fatalf("paths %v", got)
	}
	// Persisted across managers.
	if got := e.manager().Paths(); len(got) != 1 {
		t.Fatal("not persisted")
	}
	if err := m.RemovePath(extra); err != nil || len(m.Paths()) != 0 {
		t.Fatal("remove failed")
	}
}

func TestSigningSwappedPublicKeyRejected(t *testing.T) {
	e := newTestEnv(t)
	lib, other := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("luna.minisign.pub", genKey(t))
	e.write(filepath.Join(e.home, ".minisign", "sol.key"), e.encrypted(other, "pw"))
	e.pr = passphrases("pw")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if err := m.Unlock(ctx, SolSigning); err == nil {
		t.Fatal("a stale key must not unlock")
	}
	st := m.Status(ctx, SolSigning)
	if st.State == Proven {
		t.Fatal("a stale key must not prove")
	}
	found := false
	for _, c := range st.Candidates {
		if c.Outcome == Rejected && strings.Contains(c.Reason, "not a release key") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected rejected candidate: %+v", st.Candidates)
	}
}

func TestPromptScopedToTheUnitAndSkipRemembered(t *testing.T) {
	e, _, _, _ := setupKeys(t)
	ctx := context.Background()
	// First cut teaches the pairing cache which file is which key.
	e.pr = passphrases("pw-lib", "pw-luna")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	if err := m.Unlock(ctx, SolSigning, LunaSigning); err != nil {
		t.Fatal(err)
	}
	// Second cut, Sol only: a wrong release passphrase, then the user skips.
	e.pr = passphrases("wrong")
	m = e.manager(func(o *Options) { o.NoHomeScan = true })
	if err := m.Unlock(ctx, SolSigning); err == nil {
		t.Fatal("unlocked with a wrong passphrase")
	}
	st := m.Status(ctx, SolSigning)
	if st.State != Failed || !st.NeedsPassword {
		t.Fatalf("want failed + needs password: %+v", st)
	}
	qs := e.pr.passQuestions()
	for _, q := range qs {
		if strings.HasSuffix(q.Key, "sol.key") {
			t.Fatalf("a Sol cut must not ask about the Luna key file: %+v", q)
		}
	}
	if len(qs) < 2 || !strings.Contains(qs[1].Label, "Sol release signing key") || !strings.Contains(qs[1].Label, ".minisign") {
		t.Fatalf("the question must name the key and the file: %+v", qs)
	}
	if !strings.Contains(st.Candidates[len(st.Candidates)-1].Reason, "passphrases typed") {
		t.Fatalf("reason: %+v", st.Candidates)
	}
	// Looking again does not ask; unlocking again on purpose does.
	n := len(e.pr.asked)
	m.Status(ctx, SolSigning)
	if len(e.pr.asked) != n {
		t.Fatalf("a status check asked: %+v", e.pr.asked)
	}
	m.Unlock(ctx, SolSigning)
	if len(e.pr.asked) <= n {
		t.Fatal("unlocking again should ask again")
	}
}

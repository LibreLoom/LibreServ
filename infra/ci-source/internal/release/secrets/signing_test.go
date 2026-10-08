package secrets

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupKeys(t *testing.T) (*testEnv, testKey, testKey, testKey) {
	e := newTestEnv(t)
	lib, luna, other := genKey(t), genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("lsluna.minisign.pub", luna)
	// Names deliberately swapped: contents decide, not names.
	e.write(filepath.Join(e.home, ".minisign", "sol.key"), e.encrypted(luna, "pw-luna"))
	e.write(filepath.Join(e.home, ".minisign", "lsluna.key"), e.encrypted(lib, "pw-lib"))
	e.write(filepath.Join(e.home, ".minisign", "old.key"), e.encrypted(other, "pw-old"))
	return e, lib, luna, other
}

func TestSigningPairsByContentsAndCaches(t *testing.T) {
	e, lib, luna, _ := setupKeys(t)
	e.env["LSLUNA_RELEASE_MINISIG_PW"] = "pw-luna"
	e.env["MINISIGN_PASSPHRASE"] = "pw-lib"
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()

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
	// old.key has no known password: reported, not a release key.
	var sawOld bool
	for _, c := range st.Candidates {
		if strings.Contains(c.Where, "old.key") {
			sawOld = true
		}
	}
	if !sawOld {
		t.Fatalf("old.key missing from report: %+v", st.Candidates)
	}
	for _, pw := range []string{"pw-luna", "pw-lib"} {
		if !e.red.has(pw) {
			t.Errorf("password %q not registered with redactor", pw)
		}
	}
	// Cache: non-secret facts only.
	b, err := os.ReadFile(filepath.Join(e.home, ".cache", "libreserv-release", "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"pw-luna", "pw-lib"} {
		if strings.Contains(string(b), secret) {
			t.Fatal("cache holds a password")
		}
	}
	if !strings.Contains(string(b), keyIDString(lib.pub.ID())) || !strings.Contains(string(b), "env MINISIGN_PASSPHRASE") {
		t.Fatalf("cache lacks key ID / password source: %s", b)
	}
}

func TestSigningFailedThenPrompted(t *testing.T) {
	e, lib, luna, _ := setupKeys(t)
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	st := m.Status(ctx, SolSigning)
	if st.State != Failed {
		t.Fatalf("want failed without passwords, got %+v", st)
	}
	// Interactive: user types both passwords; "remember" stores them.
	e.pr = &fakePrompter{answers: map[string]Answer{SlotMinisignPassword: {Value: "pw-lib", Remember: true}}}
	m = e.manager(func(o *Options) { o.NoHomeScan = true })
	st = m.Status(ctx, SolSigning)
	if st.State != Proven {
		t.Fatalf("prompted: %+v", st)
	}
	if len(e.pr.asked) == 0 || !e.pr.asked[0].Secret {
		t.Fatal("expected a secret prompt")
	}
	if v, _ := m.opt.Store.Get(SlotMinisignPassword); v != "pw-lib" {
		t.Fatal("password not remembered")
	}
	_ = luna
	_ = lib
	// Luna stays unproven (nobody knows pw-luna); asked once per file only.
	if st := m.Status(ctx, LunaSigning); st.State != Failed {
		t.Fatalf("luna: %+v", st)
	}
}

func TestSigningMissingAndScan(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("lsluna.minisign.pub", luna)
	e.write(filepath.Join(e.home, "Documents", "stuff", "backup.txt"), e.encrypted(lib, "pw"))
	e.env["MINISIGN_PASSPHRASE"] = "pw"

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	if st := m.Status(context.Background(), SolSigning); st.State != Missing {
		t.Fatalf("without scan: %+v", st)
	}
	m = e.manager()
	if st := m.Status(context.Background(), SolSigning); st.State != Proven {
		t.Fatalf("home scan should find it by header: %+v", st)
	}
	if st := m.Status(context.Background(), LunaSigning); st.State != Missing {
		t.Fatalf("luna: %+v", st)
	}
}

func TestSigningEnvFormsAndAddPath(t *testing.T) {
	e := newTestEnv(t)
	lib, luna := genKey(t), genKey(t)
	e.writePub("sol.minisign.pub", lib)
	e.writePub("lsluna.minisign.pub", luna)
	// Luna key as pasted text; sol key in a user-added folder.
	e.env["LSLUNA_RELEASE_MINISIG_PK"] = e.encrypted(luna, "p1")
	e.env["LSLUNA_RELEASE_MINISIG_PW_CMD"] = "echo p1"
	e.run = func(_ context.Context, _ string, _ []string, name string, args ...string) ([]byte, error) {
		if name == "sh" && len(args) == 2 && args[1] == "echo p1" {
			return []byte("p1\n"), nil
		}
		return nil, os.ErrNotExist
	}
	extra := filepath.Join(e.home, "vault")
	e.write(filepath.Join(extra, "k", "x.bin"), e.encrypted(lib, "p2"))
	e.env["MINISIGN_PASSPHRASE_B64"] = "cDI=" // p2

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if st := m.Status(ctx, LunaSigning); st.State != Proven {
		t.Fatalf("luna from env: %+v", st)
	}
	if st := m.Status(ctx, SolSigning); st.State != Missing {
		t.Fatalf("before AddPath: %+v", st)
	}
	if err := m.AddPath(extra); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx, SolSigning); st.State != Proven {
		t.Fatalf("after AddPath: %+v", st)
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
	e.writePub("lsluna.minisign.pub", genKey(t))
	e.write(filepath.Join(e.home, ".minisign", "sol.key"), e.encrypted(other, "pw"))
	e.env["MINISIGN_PASSPHRASE"] = "pw"
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	st := m.Status(context.Background(), SolSigning)
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

func TestPromptSkipRememberedPerFileAndScopedToTheUnit(t *testing.T) {
	e, _, _, _ := setupKeys(t)
	// First run: passwords from the environment teach the pairing cache which
	// file is which key.
	e.env["SOL_RELEASE_MINISIG_PW"] = "pw-lib"
	e.env["LSLUNA_RELEASE_MINISIG_PW"] = "pw-luna"
	ctx := context.Background()
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	for _, id := range []ID{SolSigning, LunaSigning} {
		if st := m.Status(ctx, id); st.State != Proven {
			t.Fatalf("%s: %+v", id, st)
		}
	}
	// Second run: no passwords at all; the user skips every question.
	delete(e.env, "SOL_RELEASE_MINISIG_PW")
	delete(e.env, "LSLUNA_RELEASE_MINISIG_PW")
	e.pr = &fakePrompter{}
	m = e.manager(func(o *Options) { o.NoHomeScan = true })
	st := m.Status(ctx, SolSigning)
	if st.State != Failed || !st.NeedsPassword {
		t.Fatalf("want failed + needs password: %+v", st)
	}
	for _, q := range e.pr.asked {
		if strings.HasSuffix(q.Key, "sol.key") {
			t.Fatalf("a Sol check must not ask about the Luna key file: %+v", q)
		}
	}
	if len(e.pr.asked) == 0 || !strings.Contains(e.pr.asked[0].Label, "Sol release signing key") ||
		!strings.Contains(e.pr.asked[0].Label, ".minisign") {
		t.Fatalf("the question must name the secret and the file: %+v", e.pr.asked)
	}
	n := len(e.pr.asked)
	m.Refresh()
	m.Status(ctx, SolSigning)
	if len(e.pr.asked) != n {
		t.Fatalf("a skipped file must not be asked again this run: %+v", e.pr.asked)
	}
	m.Status(ctx, LunaSigning) // asks about the Luna file once; the other files were skipped already
	if len(e.pr.asked) != n+1 {
		t.Fatalf("luna: want one more question, got %+v", e.pr.asked)
	}
	if !strings.Contains(st.Candidates[len(st.Candidates)-1].Reason, "No password entered yet") {
		t.Fatalf("reason: %+v", st.Candidates)
	}
	// Proving again on purpose asks again.
	m.Reprove(ctx, SolSigning, false)
	if len(e.pr.asked) <= n+1 {
		t.Fatalf("reprove should ask again: %d", len(e.pr.asked))
	}
}

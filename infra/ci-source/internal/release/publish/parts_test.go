package publish

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

func TestSemver(t *testing.T) {
	order := []string{"0.3.0-beta.2", "0.3.0-beta.10", "0.3.0", "0.4.0-0.dev.12", "0.4.0", "1.0.0"}
	// dev builds sort below the betas of their version
	order = []string{"0.3.0-beta.2", "0.3.0-beta.10", "0.3.0", "0.4.0-0.dev.12", "0.4.0-beta.1", "0.4.0", "1.0.0"}
	for i := range order {
		for j := range order {
			got, err := CompareSemver(order[i], order[j])
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if err != nil || got != want {
				t.Fatalf("%s vs %s = %d (%v), want %d", order[i], order[j], got, err, want)
			}
		}
	}
	for _, bad := range []string{"v1.0.0", "01.0.0", "1.0", "1.0.0+x", "1.0.0-01", ""} {
		if ValidSemver(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestSumsAndSignature(t *testing.T) {
	pub, signer := testKey(t)
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "b.bin"), []byte("bee"), 0o644)
	os.WriteFile(filepath.Join(dir, "a.bin"), []byte("ay"), 0o644)
	files, err := WriteSigned(dir, "luna", "0.4.0", signer)
	if err != nil {
		t.Fatal(err)
	}
	sums, _ := os.ReadFile(filepath.Join(dir, SumsName))
	lines := strings.Split(strings.TrimSpace(string(sums)), "\n")
	if len(lines) != 2 || !strings.HasSuffix(lines[0], "  a.bin") || !strings.HasPrefix(lines[1], files["b.bin"].SHA256+"  b.bin") {
		t.Fatalf("sums:\n%s", sums)
	}
	sig, _ := os.ReadFile(filepath.Join(dir, SumsSigName))
	if !minisign.Verify(pub, sums, sig) {
		t.Fatal("signature does not verify")
	}
	// prehashed ED, with the planned trusted comment
	if !strings.Contains(string(sig), "trusted comment: libreserv release luna 0.4.0") {
		t.Fatalf("sig:\n%s", sig)
	}
	if sigAlg := strings.SplitN(string(sig), "\n", 3)[1]; !strings.HasPrefix(sigAlg, "RU") { // base64 of "ED"
		t.Fatalf("not ED: %s", sigAlg)
	}
	// running again on a dir that now holds the sums changes nothing
	if _, err := WriteSigned(dir, "luna", "0.4.0", signer); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(dir, SumsName))
	if string(again) != string(sums) {
		t.Fatal("sums not stable")
	}
}

func TestPlanFeeds(t *testing.T) {
	files := map[string]FileInfo{
		"lunad": {Size: 5, SHA256: "aa"}, "flatpak-stable": {Size: 7, SHA256: "bb"}, "flatpak-beta": {Size: 8, SHA256: "cc"},
	}
	urlFor := func(v, f string) string { return "https://x/" + v + "/" + f }
	rel := Release{Unit: "luna-desktop", Version: "0.4.0", Channel: Stable, Published: "2026-10-12T14:03:00Z",
		Parts: []PartSpec{
			{Name: "lunad", OS: "linux", Arch: "amd64", File: "lunad"},
			{Name: "flatpak", OS: "linux", Arch: "amd64", File: "flatpak-stable", Channel: Stable},
			{Name: "flatpak", OS: "linux", Arch: "amd64", File: "flatpak-beta", Channel: Beta},
			{Name: "os", OS: "linux", Arch: "amd64", File: "os.img.xz", Version: "0.3.0", Size: 9, SHA256: "dd"},
		}}
	none := func(string) (*feed.Feed, error) { return nil, nil }

	outs, err := PlanFeeds(rel, files, urlFor, none)
	if err != nil || len(outs) != 2 {
		t.Fatalf("%v %v", outs, err)
	}
	if outs[0].Channel != Stable || outs[1].Channel != Beta {
		t.Fatal("channel order")
	}
	if outs[0].Feed.Parts[1].File != "flatpak-stable" || outs[1].Feed.Parts[1].File != "flatpak-beta" {
		t.Fatalf("per-channel parts: %+v / %+v", outs[0].Feed.Parts, outs[1].Feed.Parts)
	}
	if got := outs[0].Feed.Parts[2].URLs[0]; got != "https://x/0.3.0/os.img.xz" {
		t.Fatalf("earlier-version part url %s", got)
	}

	// beta already newer (a later beta of the next version): leave it alone
	cur := func(ch string) (*feed.Feed, error) {
		if ch == Beta {
			return &feed.Feed{Version: "0.5.0-beta.1", Published: "2026-10-01T00:00:00Z"}, nil
		}
		return nil, nil
	}
	outs, err = PlanFeeds(rel, files, urlFor, cur)
	if err != nil || len(outs) != 1 || outs[0].Channel != Stable {
		t.Fatalf("%v %v", outs, err)
	}
	// beta older: stable pulls it forward
	cur = func(ch string) (*feed.Feed, error) {
		if ch == Beta {
			return &feed.Feed{Version: "0.4.0-beta.3", Published: "2026-10-01T00:00:00Z"}, nil
		}
		return nil, nil
	}
	if outs, err = PlanFeeds(rel, files, urlFor, cur); err != nil || len(outs) != 2 {
		t.Fatalf("%v %v", outs, err)
	}
	// a beta release only writes beta
	b := rel
	b.Version, b.Channel = "0.5.0-beta.1", Beta
	if outs, err = PlanFeeds(b, files, urlFor, none); err != nil || len(outs) != 1 || outs[0].Channel != Beta {
		t.Fatalf("%v %v", outs, err)
	}
	// never backwards
	cur = func(ch string) (*feed.Feed, error) {
		if ch == Stable {
			return &feed.Feed{Version: "0.4.1", Published: "2026-10-01T00:00:00Z"}, nil
		}
		return nil, nil
	}
	if _, err = PlanFeeds(rel, files, urlFor, cur); err == nil {
		t.Fatal("older version accepted")
	}
	cur = func(ch string) (*feed.Feed, error) {
		if ch == Stable {
			return &feed.Feed{Version: "0.3.0", Published: "2027-01-01T00:00:00Z"}, nil
		}
		return nil, nil
	}
	if _, err = PlanFeeds(rel, files, urlFor, cur); err == nil {
		t.Fatal("older published accepted")
	}
	// missing file
	delete(files, "lunad")
	if _, err = PlanFeeds(rel, files, urlFor, none); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestRegistry(t *testing.T) {
	reg := newFakeRegistry("tok")
	srv := httptest.NewServer(reg)
	defer srv.Close()
	r := &Registry{BaseURL: srv.URL, Owner: "o", Token: StaticToken("tok")}
	ctx := context.Background()
	dir := t.TempDir()
	p := filepath.Join(dir, "f")
	os.WriteFile(p, []byte("hello"), 0o644)

	if res, err := r.Upload(ctx, "u", "1.0.0", "f", p); err != nil || res.Existed {
		t.Fatalf("%v %+v", err, res)
	}
	// same bytes again: fine
	if res, err := r.Upload(ctx, "u", "1.0.0", "f", p); err != nil || !res.Existed {
		t.Fatalf("%v %+v", err, res)
	}
	// different bytes: conflict, registry untouched
	os.WriteFile(p, []byte("HELLO"), 0o644)
	if _, err := r.Upload(ctx, "u", "1.0.0", "f", p); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	if string(reg.files["/api/packages/o/generic/u/1.0.0/f"]) != "hello" {
		t.Fatal("registry overwritten")
	}
	want, _ := HashFile(p)
	if err := r.Check(ctx, "u", "1.0.0", "f", want); !errors.Is(err, ErrConflict) {
		t.Fatalf("check: %v", err)
	}
	// delete, twice
	for i := 0; i < 2; i++ {
		if err := r.Delete(ctx, "u", "1.0.0", "f"); err != nil {
			t.Fatal(err)
		}
	}
	if len(reg.files) != 0 {
		t.Fatal("not deleted")
	}
	// wrong token: error, and the token is not in it
	bad := &Registry{BaseURL: srv.URL, Owner: "o", Token: StaticToken("nope-secret")}
	_, err := bad.Upload(ctx, "u", "1.0.0", "f", p)
	if err == nil || strings.Contains(err.Error(), "nope-secret") {
		t.Fatalf("err %v", err)
	}
	if s := (StaticToken("abc")).String(); s != "[redacted]" {
		t.Fatal(s)
	}
}

func TestRegistryRetries5xx(t *testing.T) {
	reg := newFakeRegistry("")
	reg.failPut = func(n int, _ string) int {
		if n <= 2 {
			return 502
		}
		return 0
	}
	srv := httptest.NewServer(reg)
	defer srv.Close()
	r := &Registry{BaseURL: srv.URL, Owner: "o", Retries: 3}
	p := filepath.Join(t.TempDir(), "f")
	os.WriteFile(p, []byte("x"), 0o644)
	if _, err := r.Upload(context.Background(), "u", "1.0.0", "f", p); err != nil {
		t.Fatal(err)
	}
	if reg.puts != 3 {
		t.Fatalf("puts %d", reg.puts)
	}
	// 4xx other than conflict is not retried
	reg.failPut = func(int, string) int { return 403 }
	reg.puts = 0
	if _, err := r.Upload(context.Background(), "u", "2.0.0", "f", p); err == nil || reg.puts != 1 {
		t.Fatalf("%v puts %d", err, reg.puts)
	}
}

func TestVerifyFeedEndToEnd(t *testing.T) {
	w := newWorld(t)
	if _, err := Run(context.Background(), w.cfg); err != nil {
		t.Fatal(err)
	}
	pub := w.cfg.Signer.(MinisignSigner).Key.Public().(minisign.PublicKey)
	f := w.cfg.Forge
	fd, err := VerifyFeed(context.Background(), nil, f.RawFeedURL("luna", "stable"), pub)
	if err != nil || fd.Version != "0.4.0" {
		t.Fatalf("%v %v", fd, err)
	}
	// wrong key
	other, _, _ := minisign.GenerateKey(rand.Reader)
	if _, err := VerifyFeed(context.Background(), nil, f.RawFeedURL("luna", "stable"), other); err == nil {
		t.Fatal("wrong key accepted")
	}
	// corrupt a registry file
	w.reg.files["/api/packages/LibreLoom/generic/luna/0.4.0/lunad-linux-amd64-musl"] = []byte("corrupt")
	if _, err := VerifyFeed(context.Background(), nil, f.RawFeedURL("luna", "stable"), pub); err == nil {
		t.Fatal("corrupt part accepted")
	}
	_ = http.StatusOK
}

func TestStableCutPullsBetaForward(t *testing.T) {
	w := newWorld(t)
	absent := func(ref string) bool {
		return exec.Command("git", "-C", w.origin, "cat-file", "-e", ref).Run() != nil
	}
	// a beta release first: only the beta feed appears
	w.cfg.Release.Version, w.cfg.Release.Channel = "0.4.0-beta.1", Beta
	w.cfg.Bump = func(dir string) ([]string, error) {
		return []string{"luna/VERSION"}, os.WriteFile(filepath.Join(dir, "luna", "VERSION"), []byte("0.4.0-beta.1\n"), 0o644)
	}
	if _, err := Run(context.Background(), w.cfg); err != nil {
		t.Fatal(err)
	}
	if !absent("feeds:luna/stable.json") {
		t.Fatal("stable feed written by a beta cut")
	}
	// then the stable release moves beta forward too
	w.cfg.Release.Version, w.cfg.Release.Channel = "0.4.0", Stable
	w.cfg.Bump = func(dir string) ([]string, error) {
		return []string{"luna/VERSION"}, os.WriteFile(filepath.Join(dir, "luna", "VERSION"), []byte("0.4.0\n"), 0o644)
	}
	if _, err := Run(context.Background(), w.cfg); err != nil {
		t.Fatal(err)
	}
	for _, ch := range []string{"stable", "beta"} {
		var f feed.Feed
		if err := json.Unmarshal([]byte(sh(t, w.origin, "show", "feeds:luna/"+ch+".json")), &f); err != nil || f.Version != "0.4.0" {
			t.Fatalf("%s: %+v %v", ch, f, err)
		}
	}
	if n := sh(t, w.origin, "rev-list", "--count", "feeds"); n != "2" {
		t.Fatalf("feed commits %s", n)
	}
}

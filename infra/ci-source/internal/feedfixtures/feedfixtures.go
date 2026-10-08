// Package feedfixtures generates the signed TEST-ONLY feeds in
// infra/feed-testdata/. Everything is deterministic: same code, same bytes.
package feedfixtures

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

const (
	URLBase        = "http://feed-test.invalid"
	TrustedComment = "TEST ONLY - libreserv feed fixtures"
	keyComment     = "untrusted comment: TEST ONLY - libreserv feed fixtures - never trust this key in production"

	published = "2026-10-12T14:03:00Z"
	older     = "2026-10-01T00:00:00Z"
	newer     = "2026-10-13T00:00:00Z"
)

// detReader is an endless deterministic byte stream: SHA-256(seed || counter).
type detReader struct {
	seed string
	n    uint64
	buf  []byte
}

func (r *detReader) Read(p []byte) (int, error) {
	for i := range p {
		if len(r.buf) == 0 {
			var c [8]byte
			binary.BigEndian.PutUint64(c[:], r.n)
			r.n++
			h := sha256.Sum256(append([]byte(r.seed), c[:]...))
			r.buf = h[:]
		}
		p[i] = r.buf[0]
		r.buf = r.buf[1:]
	}
	return len(p), nil
}

func genKey(seed string) (minisign.PublicKey, minisign.PrivateKey, error) {
	return minisign.GenerateKey(&detReader{seed: seed})
}

// TestKey returns the TEST-ONLY signing key.
func TestKey() (minisign.PublicKey, minisign.PrivateKey, error) {
	return genKey("sol-feed-testdata")
}

// OtherKey returns a second TEST-ONLY key, used for wrong-key signatures.
func OtherKey() (minisign.PublicKey, minisign.PrivateKey, error) {
	return genKey("sol-feed-testdata-other")
}

func payload(path string, size int) []byte {
	b := make([]byte, size)
	(&detReader{seed: "payload:" + path}).Read(b)
	return b
}

func sum(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }

type gen struct {
	dir   string
	priv  minisign.PrivateKey
	other minisign.PrivateKey
	cases []map[string]any
	err   error
}

func (g *gen) write(rel string, b []byte) {
	if g.err != nil {
		return
	}
	p := filepath.Join(g.dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		g.err = err
		return
	}
	g.err = os.WriteFile(p, b, 0o644)
}

func (g *gen) sign(key minisign.PrivateKey, b []byte) []byte {
	s, err := feed.Sign(key, b, TrustedComment)
	if err != nil && g.err == nil {
		g.err = err
	}
	return s
}

// part builds a part whose payload is written under files/generic/<unit>/<ver>/<file>.
func (g *gen) part(unit, ver, name, os_, arch, file string, size int) feed.Part {
	rel := fmt.Sprintf("generic/%s/%s/%s", unit, ver, file)
	b := payload(rel, size)
	g.write(filepath.Join("files", rel), b)
	return feed.Part{Name: name, OS: os_, Arch: arch, File: file, Size: int64(len(b)), SHA256: sum(b),
		URLs: []string{URLBase + "/" + rel}}
}

func (g *gen) feedFile(name string, f feed.Feed) []byte {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil && g.err == nil {
		g.err = err
	}
	b = append(b, '\n')
	g.write(name, b)
	g.write(name+".minisig", g.sign(g.priv, b))
	return b
}

type req struct {
	Unit, Channel, OS, Arch, Part, Installed, Seen string
}

func (r req) m() map[string]any {
	return map[string]any{"unit": r.Unit, "channel": r.Channel, "os": r.OS, "arch": r.Arch,
		"part": r.Part, "installed_version": r.Installed, "newest_published_seen": r.Seen}
}

func (g *gen) add(name, feedFile, sigFile string, r req, expect string) {
	if sigFile == "" {
		sigFile = feedFile + ".minisig"
	}
	g.cases = append(g.cases, map[string]any{"name": name, "feed": feedFile, "sig": sigFile,
		"request": r.m(), "expect": expect})
}

func base(unit, channel, ver string, parts ...feed.Part) feed.Feed {
	return feed.Feed{Format: 1, Unit: unit, Channel: channel, Version: ver, Published: published,
		Notes: "Test release " + ver, Parts: parts}
}

// Generate writes all fixtures into dir.
func Generate(dir string) error {
	pub, priv, err := TestKey()
	if err != nil {
		return err
	}
	_, other, err := OtherKey()
	if err != nil {
		return err
	}
	g := &gen{dir: dir, priv: priv, other: other}
	g.write("test-key.pub", []byte(keyComment+"\n"+pub.String()+"\n"))

	// --- luna 0.4.0 stable ---
	lunad := g.part("luna", "0.4.0", "lunad", "linux", "amd64", "lunad-linux-amd64-musl", 320)
	osimg := g.part("luna", "0.4.0", "os", "linux", "amd64", "luna-os-x86_64.img.xz", 400)
	luna := base("luna", "stable", "0.4.0", lunad, osimg)
	luna.API = &feed.API{Version: 3, OldestSupported: 2}
	lunaB := g.feedFile("luna-stable.json", luna)
	lr := func(installed, seen string) req {
		return req{"luna", "stable", "linux", "amd64", "lunad", installed, seen}
	}
	g.add("update-newer", "luna-stable.json", "", lr("0.3.0", ""), "update")
	g.add("update-os-part", "luna-stable.json", "", req{"luna", "stable", "linux", "amd64", "os", "0.3.0", older}, "update")
	g.add("no-update-same-version", "luna-stable.json", "", lr("0.4.0", ""), "no-update")
	g.add("no-update-lower-version", "luna-stable.json", "", lr("0.5.0", ""), "no-update")
	g.add("accepted-published-newer-than-seen", "luna-stable.json", "", lr("0.3.0", older), "update")
	g.add("accepted-published-equal-to-seen", "luna-stable.json", "", lr("0.3.0", published), "update")
	g.add("reject-replayed-older-published", "luna-stable.json", "", lr("0.3.0", newer), "reject:replayed")
	g.add("reject-wrong-unit", "luna-stable.json", "", req{"luna-desktop", "stable", "linux", "amd64", "flatpak", "0.3.0", ""}, "reject:wrong-unit")
	g.add("reject-wrong-channel", "luna-stable.json", "", req{"luna", "beta", "linux", "amd64", "lunad", "0.3.0", ""}, "reject:wrong-channel")
	g.add("reject-missing-arch", "luna-stable.json", "", req{"luna", "stable", "linux", "arm64", "lunad", "0.3.0", ""}, "reject:missing-part")
	g.add("reject-missing-part-name", "luna-stable.json", "", req{"luna", "stable", "linux", "amd64", "installer", "0.3.0", ""}, "reject:missing-part")
	g.add("reject-missing-os", "luna-stable.json", "", req{"luna", "stable", "windows", "amd64", "lunad", "0.3.0", ""}, "reject:missing-part")
	g.add("download-ok", "luna-stable.json", "", lr("0.3.0", ""), "download-ok")
	// signature problems
	g.write("luna-stable.json.wrongkey.minisig", g.sign(other, lunaB))
	g.add("reject-signature-from-other-key", "luna-stable.json", "luna-stable.json.wrongkey.minisig", lr("0.3.0", ""), "reject:bad-signature")

	// --- sol 0.9.1 stable ---
	solA := g.part("sol", "0.9.1", "sol", "linux", "amd64", "sol-linux-amd64", 350)
	solR := g.part("sol", "0.9.1", "sol", "linux", "arm64", "sol-linux-arm64", 360)
	g.feedFile("sol-stable.json", base("sol", "stable", "0.9.1", solA, solR))
	sr := func(arch string) req { return req{"sol", "stable", "linux", arch, "sol", "0.9.0", ""} }
	g.add("sol-update-amd64", "sol-stable.json", "", sr("amd64"), "update")
	g.add("sol-update-arm64", "sol-stable.json", "", sr("arm64"), "update")
	g.add("reject-signature-of-other-feed", "luna-stable.json", "sol-stable.json.minisig", lr("0.3.0", ""), "reject:bad-signature")
	g.add("reject-wrong-unit-sol-feed-for-luna", "sol-stable.json", "", lr("0.3.0", ""), "reject:wrong-unit")
	// signature is valid for the feed but the feed bytes were changed afterwards
	tampered := []byte(strings.Replace(string(lunaB), "0.4.0\"", "9.9.9\"", 1))
	g.write("luna-stable.tampered.json", tampered)
	g.write("luna-stable.tampered.json.minisig", g.sign(priv, lunaB))
	g.add("reject-tampered-feed", "luna-stable.tampered.json", "", lr("0.3.0", ""), "reject:bad-signature")

	// --- unknown format ---
	f2 := base("luna", "stable", "0.4.0", lunad)
	f2.Format = 2
	g.feedFile("luna-format2.json", f2)
	g.add("reject-unknown-format", "luna-format2.json", "", lr("0.3.0", ""), "reject:unknown-format")

	// --- unknown extra JSON fields ---
	extra := map[string]any{}
	_ = json.Unmarshal(lunaB, &extra)
	extra["future_field"] = map[string]any{"a": 1}
	for _, p := range extra["parts"].([]any) {
		p.(map[string]any)["mirror_hint"] = "eu"
	}
	extra["api"].(map[string]any)["new_thing"] = true
	eb, _ := json.MarshalIndent(extra, "", "  ")
	eb = append(eb, '\n')
	g.write("luna-extra-fields.json", eb)
	g.write("luna-extra-fields.json.minisig", g.sign(priv, eb))
	g.add("unknown-fields-ignored", "luna-extra-fields.json", "", lr("0.3.0", ""), "update")

	// --- beta ordering ---
	bfeed := base("luna", "beta", "0.3.0-beta.10", g.part("luna", "0.3.0-beta.10", "lunad", "linux", "amd64", "lunad-linux-amd64-musl", 310))
	g.feedFile("luna-beta.json", bfeed)
	g.add("beta-2-to-beta-10", "luna-beta.json", "", req{"luna", "beta", "linux", "amd64", "lunad", "0.3.0-beta.2", ""}, "update")
	g.add("beta-same", "luna-beta.json", "", req{"luna", "beta", "linux", "amd64", "lunad", "0.3.0-beta.10", ""}, "no-update")
	g.add("beta-feed-older-than-release", "luna-beta.json", "", req{"luna", "beta", "linux", "amd64", "lunad", "0.3.0", ""}, "no-update")
	g.add("beta-9-vs-10-not-string-order", "luna-beta.json", "", req{"luna", "beta", "linux", "amd64", "lunad", "0.3.0-beta.9", ""}, "update")
	rel := base("luna", "stable", "0.3.0", g.part("luna", "0.3.0", "lunad", "linux", "amd64", "lunad-linux-amd64-musl", 305))
	g.feedFile("luna-stable-0.3.0.json", rel)
	g.add("beta-10-to-release", "luna-stable-0.3.0.json", "", lr("0.3.0-beta.10", ""), "update")

	// --- any/any and other os parts ---
	web := g.part("sol-connect", "0.2.0", "web", "any", "any", "sol-connect-web.tar.gz", 330)
	srv := g.part("sol-connect", "0.2.0", "server", "linux", "amd64", "sol-connect-server-linux-amd64", 340)
	g.feedFile("sol-connect-stable.json", base("sol-connect", "stable", "0.2.0", srv, web))
	g.add("any-any-part-matches", "sol-connect-stable.json", "", req{"sol-connect", "stable", "linux", "amd64", "web", "0.1.0", ""}, "update")
	win := g.part("luna-desktop", "0.4.0", "windows", "windows", "amd64", "Luna-Desktop-Setup-x86_64.exe", 380)
	fp := g.part("luna-desktop", "0.4.0", "flatpak", "linux", "amd64", "luna-desktop-x86_64.flatpak", 370)
	g.feedFile("luna-desktop-stable.json", base("luna-desktop", "stable", "0.4.0", fp, win))
	g.add("desktop-windows-update", "luna-desktop-stable.json", "", req{"luna-desktop", "stable", "windows", "amd64", "windows", "0.3.0", ""}, "update")
	apk := g.part("luna-android", "0.4.0", "apk", "android", "any", "luna-android.apk", 390)
	g.feedFile("luna-android-stable.json", base("luna-android", "stable", "0.4.0", apk))
	g.add("android-any-arch", "luna-android-stable.json", "", req{"luna-android", "stable", "android", "arm64", "apk", "0.3.0", ""}, "update")

	// --- download failures ---
	dr := req{"luna", "stable", "linux", "amd64", "lunad", "0.3.0", ""}
	d := func(mut func(p *feed.Part)) feed.Feed {
		p := lunad
		p.URLs = append([]string(nil), lunad.URLs...)
		mut(&p)
		return base("luna", "stable", "0.4.0", p)
	}
	g.feedFile("luna-dl-size-mismatch.json", d(func(p *feed.Part) { p.Size++ }))
	g.add("download-size-mismatch", "luna-dl-size-mismatch.json", "", dr, "download-fail:size-mismatch")
	g.feedFile("luna-dl-sha-mismatch.json", d(func(p *feed.Part) { p.SHA256 = sum([]byte("not the file")) }))
	g.add("download-sha-mismatch", "luna-dl-sha-mismatch.json", "", dr, "download-fail:sha-mismatch")
	missing := URLBase + "/missing/generic/luna/0.4.0/lunad-linux-amd64-musl"
	g.feedFile("luna-dl-fallback.json", d(func(p *feed.Part) { p.URLs = []string{missing, p.URLs[0]} }))
	g.add("download-first-url-404-second-ok", "luna-dl-fallback.json", "", dr, "download-ok")
	g.feedFile("luna-dl-all-missing.json", d(func(p *feed.Part) { p.URLs = []string{missing, URLBase + "/missing/other/lunad"} }))
	g.add("download-all-urls-404", "luna-dl-all-missing.json", "", dr, "download-fail:all-urls-failed")

	// --- SHA256SUMS.txt exact-name matching ---
	lunadSum, osSum := lunad.SHA256, osimg.SHA256
	decoy := sum([]byte("decoy"))
	sums := fmt.Sprintf("%s  lunad-linux-amd64-musl.sig\n%s  old-lunad-linux-amd64-musl\n%s  lunad-linux-amd64-musl\n%s  luna-os-x86_64.img.xz\n",
		decoy, decoy, lunadSum, osSum)
	g.write("files/generic/luna/0.4.0/SHA256SUMS.txt", []byte(sums))
	g.write("files/generic/luna/0.4.0/SHA256SUMS.txt.minisig", g.sign(priv, []byte(sums)))
	sumsCases := []map[string]any{
		{"name": "exact-name-found", "file": "lunad-linux-amd64-musl", "expect": lunadSum},
		{"name": "exact-name-other-file", "file": "luna-os-x86_64.img.xz", "expect": osSum},
		{"name": "substring-is-not-a-match", "file": "linux-amd64-musl", "expect": "not-found"},
		{"name": "prefix-is-not-a-match", "file": "lunad-linux-amd64", "expect": "not-found"},
		{"name": "unknown-file", "file": "nope.bin", "expect": "not-found"},
	}

	cases := map[string]any{
		"key":      "test-key.pub",
		"url_base": URLBase,
		"cases":    g.cases,
		"sums": map[string]any{
			"file": "files/generic/luna/0.4.0/SHA256SUMS.txt",
			"sig":  "files/generic/luna/0.4.0/SHA256SUMS.txt.minisig", "cases": sumsCases},
		"semver": map[string]any{
			"ascending": []string{"0.3.0-alpha", "0.3.0-beta.2", "0.3.0-beta.10", "0.3.0", "0.3.1", "0.10.0", "1.0.0-rc.1", "1.0.0", "2.0.0"},
			"invalid":   []string{"v1.0.0", "0.3", "1", "01.0.0", "1.02.0", "1.0.03", "1.0.0-", "1.0.0-beta.01", "1.0.0-beta..1", "1.2.3.4", " 1.0.0", "1.0.0 ", ""},
		},
	}
	cb, err := json.MarshalIndent(cases, "", "  ")
	if err != nil {
		return err
	}
	g.write("cases.json", append(cb, '\n'))
	return g.err
}

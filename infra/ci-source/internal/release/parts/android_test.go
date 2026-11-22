package parts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func TestAndroidVersionCheck(t *testing.T) {
	b := lunaCtx(t, "luna-android", "0.4.0") // gradle file: 40099 / 0.4.0
	for ver, ok := range map[string]bool{
		"0.4.0":          true,
		"0.4.1-0.dev.12": true, // dev builds keep the bump commit's values
		"0.4.1":          false,
		"0.4.0-beta.1":   false,
	} {
		err := checkAndroidVersion(b.SrcDir, ver)
		if (err == nil) != ok {
			t.Errorf("%s: err=%v, want ok=%v", ver, err, ok)
		}
	}
}

func TestAPKSpec(t *testing.T) {
	b := lunaCtx(t, "luna-android", "0.4.0")
	img := engine.Image{Name: "android", Hash: "h"}
	p := &APK{}
	m := jobIDs(t, b, p)
	if _, ok := m[APKJob]; !ok || APKFile != "luna-android.apk" {
		t.Fatal(m)
	}
	s, err := p.spec(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Env["LUNA_ANDROID_RELEASE"]; ok {
		t.Error("a dev build asked for a release APK")
	}
	if s.Env["EXPECT_VERSION_NAME"] != "0.4.0" || s.Env["EXPECT_VERSION_CODE"] != "40099" {
		t.Errorf("version pins = %q / %q", s.Env["EXPECT_VERSION_NAME"], s.Env["EXPECT_VERSION_CODE"])
	}

	ks := filepath.Join(t.TempDir(), "k.jks")
	os.WriteFile(ks, []byte("x"), 0o600)
	b.AndroidSigning = &engine.AndroidSigning{Path: ks, Alias: "luna", StorePassword: []byte("sekret-store"), KeyPassword: []byte("sekret-key"), CertSHA256: "AB12"}

	// The gradle step: network, source and caches, but never the keystore
	// or a password.
	s, err = p.spec(b)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Join(b.Engine.RunArgs(img, s, "n"), " ")
	if strings.Contains(argv, "sekret") || strings.Contains(argv, ks) || strings.Contains(argv, "/keys/") {
		t.Errorf("gradle step can reach the keystore:\n%s", argv)
	}
	for k, v := range s.Env {
		if strings.Contains(v, "sekret") || strings.Contains(k, "PASSWORD") || strings.Contains(k, "KEYSTORE") {
			t.Errorf("gradle step env %s=%q", k, v)
		}
	}
	if len(s.Stdin) != 0 {
		t.Error("gradle step got standard input")
	}
	if s.Env["LUNA_ANDROID_RELEASE"] != "1" {
		t.Error("release build not asked for")
	}
	for _, w := range []string{"luna-android-app-build:/src/luna/mobile/app/build", "gradle:/root/.gradle"} {
		if !strings.Contains(argv, w) {
			t.Errorf("gradle args lack %q:\n%s", w, argv)
		}
	}

	// The signing step: no network, no source, no caches; keystore read-only;
	// passwords on stdin only.
	sg, err := p.signSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	argv = strings.Join(b.Engine.RunArgs(img, sg, "n"), " ")
	if sg.Network != "none" || !strings.Contains(argv, "--network none") {
		t.Errorf("signing step has a network:\n%s", argv)
	}
	if !strings.Contains(argv, ks+":/keys/release.keystore:ro") || !strings.Contains(argv, "--interactive") {
		t.Errorf("signing args:\n%s", argv)
	}
	if strings.Contains(argv, "sekret") || strings.Contains(argv, "/src") || strings.Contains(argv, "gradle") || len(sg.Caches) != 0 {
		t.Errorf("signing step sees more than the APK and the keystore:\n%s", argv)
	}
	for k, v := range sg.Env {
		if strings.Contains(v, "sekret") {
			t.Errorf("password in env %s", k)
		}
	}
	if string(sg.Stdin) != "sekret-store\nsekret-key\n" {
		t.Errorf("stdin = %q", sg.Stdin)
	}
	if sg.Env["EXPECT_CERT_SHA256"] != "ab12" || sg.Env["KEY_ALIAS"] != "luna" {
		t.Errorf("signing env = %v", sg.Env)
	}

	// A locked keystore never reaches a container.
	b.AndroidSigning.StorePassword = nil
	if _, err := p.signSpec(b); err == nil {
		t.Error("signed with no password")
	}
}

func TestIntegrationAPK(t *testing.T) {
	slowOrSkip(t)
	b := lunaRealCtx(t, "luna-android", "0.1.6-0.dev.1")
	d := runGraph(t, b, &APK{})
	t.Logf("apk: %s", d.Round(time.Second))
	st, err := os.Stat(filepath.Join(b.PartOutDir("apk"), APKFile))
	if err != nil || st.Size() < 1<<20 {
		t.Fatalf("apk: %v %v", st, err)
	}
}

func TestIntegrationAPKSigned(t *testing.T) {
	slowOrSkip(t)
	b := lunaRealCtx(t, "luna-android", "0.1.6-0.dev.2")
	img, err := b.Engine.EnsureImage(context.Background(), "android", engine.BuildOpts{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	os.Chmod(dir, 0o755)
	out, err := exec.Command("podman", "run", "--rm", "--security-opt", "label=disable", "-v", dir+":/ks", img.Ref(),
		"keytool", "-genkeypair", "-keystore", "/ks/t.jks", "-storepass", "teststorepw", "-keypass", "teststorepw",
		"-alias", "luna", "-keyalg", "RSA", "-keysize", "2048", "-validity", "30", "-dname", "CN=test").CombinedOutput()
	if err != nil {
		t.Fatalf("keytool: %v\n%s", err, out)
	}
	b.AndroidSigning = &engine.AndroidSigning{Path: filepath.Join(dir, "t.jks"), Alias: "luna",
		StorePassword: []byte("teststorepw"), KeyPassword: []byte("teststorepw")}
	d := runGraph(t, b, &APK{})
	t.Logf("signed apk: %s", d.Round(time.Second))
	if _, err := os.Stat(filepath.Join(b.PartOutDir("apk"), APKFile)); err != nil {
		t.Fatal(err)
	}
}

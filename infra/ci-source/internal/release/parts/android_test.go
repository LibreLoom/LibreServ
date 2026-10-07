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
	if _, ok := s.Env["LUNA_ANDROID_KEYSTORE"]; ok {
		t.Error("unsigned build got a keystore")
	}
	ks := filepath.Join(t.TempDir(), "k.jks")
	os.WriteFile(ks, []byte("x"), 0o600)
	b.AndroidSigning = &engine.AndroidSigning{Path: ks, Alias: "luna", StorePassword: "sekret-store", KeyPassword: "sekret-key"}
	s, err = p.spec(b)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Join(b.Engine.RunArgs(img, s, "n"), " ")
	if strings.Contains(argv, "sekret") {
		t.Error("password on the command line")
	}
	for _, w := range []string{ks + ":/keys/release.keystore:ro", "-e LUNA_ANDROID_STORE_PASSWORD", "-e LUNA_ANDROID_KEY_PASSWORD", "luna-android-app-build:/src/luna/mobile/app/build", "gradle:/root/.gradle"} {
		if !strings.Contains(argv, w) {
			t.Errorf("args lack %q:\n%s", w, argv)
		}
	}
	if s.Env["LUNA_ANDROID_STORE_PASSWORD"] != "sekret-store" {
		t.Error("password not in env")
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
		StorePassword: "teststorepw", KeyPassword: "teststorepw"}
	b.Engine.Redactor.Add("teststorepw")
	d := runGraph(t, b, &APK{})
	t.Logf("signed apk: %s", d.Round(time.Second))
	if _, err := os.Stat(filepath.Join(b.PartOutDir("apk"), APKFile)); err != nil {
		t.Fatal(err)
	}
}

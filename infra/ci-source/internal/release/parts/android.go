package parts

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// AndroidAPK is luna-android/apk. With BuildContext.AndroidSigning it builds
// an unsigned release APK and signs it in a separate step; without one the
// APK is debug-signed (dev builds).
var AndroidAPK = &APK{}

func init() {
	Register("luna-android", AndroidAPK)
}

// File name and job, as in the plan's parts table.
const (
	APKFile = "luna-android.apk"
	APKJob  = "luna-android/apk"
	// apkUnsigned is the gradle step's output in a release build, before
	// signing. It never stays in the part's output dir.
	apkUnsigned = "unsigned.apk"
)

// APK builds the Android app with gradle.
type APK struct{}

func (*APK) Name() string { return "apk" }
func (*APK) Unit() string { return "luna-android" }

func (a *APK) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	return []engine.Job{{ID: APKJob, Title: "Luna Android APK", Heavy: true,
		Run: func(ctx context.Context, j *engine.JobRun) error {
			if err := checkAndroidVersion(b.SrcDir, b.Version); err != nil {
				return err
			}
			spec, err := a.spec(b)
			if err != nil {
				return err
			}
			if b.AndroidSigning == nil {
				j.Log("no release keystore: building a debug-signed APK")
				return j.Container(ctx, spec)
			}
			// Gradle runs plugins and dependencies from the network, so it
			// builds an unsigned APK and never sees the keystore.
			if err := j.Container(ctx, spec); err != nil {
				return err
			}
			sign, err := a.signSpec(b)
			if err != nil {
				return err
			}
			defer wipe(sign.Stdin)
			j.Log("signing the APK with apksigner (no network, keystore read-only)")
			return j.Container(ctx, sign)
		}}}, nil
}

// spec is the gradle step: no keystore and no password, ever.
func (a *APK) spec(b *engine.BuildContext) (engine.RunSpec, error) {
	out := b.PartOutDir("apk")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return engine.RunSpec{}, err
	}
	if err := lunaMountPoints(b, "luna/mobile/.gradle", "luna/mobile/build", "luna/mobile/app/build"); err != nil {
		return engine.RunSpec{}, err
	}
	spec := engine.RunSpec{
		Name:    "apk",
		Image:   "android",
		Workdir: "/src/luna/mobile",
		Out:     out,
		Mounts:  []engine.Mount{lunaSrcMount(b)},
		Caches: []engine.Cache{engine.CacheGradle,
			{Volume: "luna-android-project", Target: "/src/luna/mobile/.gradle"},
			{Volume: "luna-android-build", Target: "/src/luna/mobile/build"},
			{Volume: "luna-android-app-build", Target: "/src/luna/mobile/app/build"}},
		Env:    map[string]string{},
		Memory: "5g",
	}
	// What the built APK must say about itself (release builds: the version's
	// own values, which checkAndroidVersion has already compared; dev builds:
	// the last bump commit's literals).
	name, code, err := androidLiterals(b.SrcDir)
	if err != nil {
		return engine.RunSpec{}, err
	}
	spec.Env["EXPECT_VERSION_NAME"] = name
	spec.Env["EXPECT_VERSION_CODE"] = strconv.Itoa(code)
	if b.AndroidSigning != nil {
		spec.Env["LUNA_ANDROID_RELEASE"] = "1"
	}
	return lunaShell(spec, "bash", "android.sh"), nil
}

// signSpec is the signing step: the android image's own zipalign and
// apksigner, no network, no source tree and no gradle caches; only the
// part's output dir and the keystore (read-only). The store and key password
// arrive on standard input, one line each.
func (a *APK) signSpec(b *engine.BuildContext) (engine.RunSpec, error) {
	s := b.AndroidSigning
	if s == nil || s.Path == "" {
		return engine.RunSpec{}, fmt.Errorf("android signing: no keystore file")
	}
	if len(s.StorePassword) == 0 || len(s.KeyPassword) == 0 {
		return engine.RunSpec{}, fmt.Errorf("android signing: the keystore is not unlocked")
	}
	for _, pw := range [][]byte{s.StorePassword, s.KeyPassword} {
		if bytes.ContainsAny(pw, "\r\n") {
			return engine.RunSpec{}, fmt.Errorf("android signing: a password with a line break cannot be passed to apksigner")
		}
	}
	stdin := make([]byte, 0, len(s.StorePassword)+len(s.KeyPassword)+2)
	stdin = append(append(append(append(stdin, s.StorePassword...), '\n'), s.KeyPassword...), '\n')
	alias := s.Alias
	if alias == "" {
		alias = "luna"
	}
	spec := engine.RunSpec{
		Name:    "apk-sign",
		Image:   "android",
		Network: "none",
		Out:     b.PartOutDir("apk"),
		Mounts:  []engine.Mount{{Host: s.Path, Target: "/keys/release.keystore", ReadOnly: true}},
		Env:     map[string]string{"KEY_ALIAS": alias},
		Stdin:   stdin,
	}
	if s.CertSHA256 != "" {
		spec.Env["EXPECT_CERT_SHA256"] = strings.ToLower(s.CertSHA256)
	}
	return lunaShell(spec, "bash", "android-sign.sh"), nil
}

// wipe zeroes b.
func wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

var (
	reVersionCode = regexp.MustCompile(`(?m)^\s*versionCode\s*=\s*(\d+)\s*$`)
	reVersionName = regexp.MustCompile(`(?m)^\s*versionName\s*=\s*"([^"]*)"\s*$`)
)

// androidLiterals reads the literal versionName and versionCode from
// build.gradle.kts.
func androidLiterals(src string) (string, int, error) {
	gradle := filepath.Join(src, "luna/mobile/app/build.gradle.kts")
	b, err := os.ReadFile(gradle)
	if err != nil {
		return "", 0, err
	}
	m := reVersionCode.FindSubmatch(b)
	n := reVersionName.FindSubmatch(b)
	if m == nil || n == nil {
		return "", 0, fmt.Errorf("%s: versionCode and versionName must be plain literals", gradle)
	}
	code, _ := strconv.Atoi(string(m[1]))
	return string(n[1]), code, nil
}

// checkAndroidVersion makes sure the literal versionName and versionCode in
// build.gradle.kts match ver (F-Droid reads those literals at the tag). Dev
// builds keep the last bump commit's values, so they are not checked.
func checkAndroidVersion(src, ver string) error {
	v, err := version.Parse(ver)
	if err != nil {
		return err
	}
	if isDevVersion(v) {
		return nil
	}
	gradle := filepath.Join(src, "luna/mobile/app/build.gradle.kts")
	b, err := os.ReadFile(gradle)
	if err != nil {
		return err
	}
	code, err := v.AndroidVersionCode()
	if err != nil {
		return err
	}
	m := reVersionCode.FindSubmatch(b)
	n := reVersionName.FindSubmatch(b)
	if m == nil || n == nil {
		return fmt.Errorf("%s: versionCode and versionName must be plain literals", gradle)
	}
	if got, _ := strconv.Atoi(string(m[1])); got != code {
		return fmt.Errorf("build.gradle.kts has versionCode %d, version %s needs %d", got, ver, code)
	}
	if string(n[1]) != ver {
		return fmt.Errorf("build.gradle.kts has versionName %q, want %q", n[1], ver)
	}
	return nil
}

// isDevVersion reports X.Y.Z-0.dev.N versions.
func isDevVersion(v version.Version) bool {
	return len(v.Pre) >= 2 && v.Pre[0] == "0" && v.Pre[1] == "dev"
}

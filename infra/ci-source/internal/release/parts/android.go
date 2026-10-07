package parts

import (
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

// AndroidAPK is luna-android/apk. It signs with BuildContext.AndroidSigning;
// without one the APK is debug-signed (dev builds).
var AndroidAPK = &APK{}

func init() {
	Register("luna-android", AndroidAPK)
}

// File name and job, as in the plan's parts table.
const (
	APKFile = "luna-android.apk"
	APKJob  = "luna-android/apk"
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
			if s := b.AndroidSigning; s != nil {
				// Never let a password reach a log line.
				j.Engine.Redactor.Add(s.StorePassword)
				j.Engine.Redactor.Add(s.KeyPassword)
			} else {
				j.Log("no release keystore: building a debug-signed APK")
			}
			return j.Container(ctx, spec)
		}}}, nil
}

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
	if s := b.AndroidSigning; s != nil {
		if s.Path == "" {
			return engine.RunSpec{}, fmt.Errorf("android signing: no keystore file")
		}
		spec.Mounts = append(spec.Mounts, engine.Mount{Host: s.Path, Target: "/keys/release.keystore", ReadOnly: true})
		spec.Env["LUNA_ANDROID_KEYSTORE"] = "/keys/release.keystore"
		spec.Env["LUNA_ANDROID_STORE_PASSWORD"] = s.StorePassword
		spec.Env["LUNA_ANDROID_KEY_PASSWORD"] = s.KeyPassword
		if s.Alias != "" {
			spec.Env["LUNA_ANDROID_KEY_ALIAS"] = s.Alias
		}
		if s.CertSHA256 != "" {
			spec.Env["EXPECT_CERT_SHA256"] = strings.ToLower(s.CertSHA256)
		}
	}
	return lunaShell(spec, "bash", "android.sh"), nil
}

var (
	reVersionCode = regexp.MustCompile(`(?m)^\s*versionCode\s*=\s*(\d+)\s*$`)
	reVersionName = regexp.MustCompile(`(?m)^\s*versionName\s*=\s*"([^"]*)"\s*$`)
)

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

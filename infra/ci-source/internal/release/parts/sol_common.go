package parts

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// Artifact is one file a part publishes: what the feed lists and what the
// registry stores. Path is where the build leaves it.
type Artifact struct {
	Unit string // release unit, "sol"
	Part string // feed part name, "sol", "server", "web"
	OS   string // linux, any
	Arch string // amd64, arm64, any
	File string // registry file name, exactly as in the plan's parts table
	Path string // absolute path of the built file
}

// artifacter is implemented by parts that publish files.
type artifacter interface {
	Artifacts(b *engine.BuildContext) []Artifact
}

// Artifacts lists the files the given parts publish for this build.
func Artifacts(b *engine.BuildContext, ps []engine.Part) []Artifact {
	var out []Artifact
	for _, p := range ps {
		if a, ok := p.(artifacter); ok {
			out = append(out, a.Artifacts(b)...)
		}
	}
	return out
}

// buildTime is the stamped BuildTime; a variable so tests can pin it.
var buildTime = func() string { return time.Now().UTC().Format("2006-01-02T15:04:05Z") }

// buildMemory is the --memory limit of toolchain containers.
const buildMemory = "4g"

// stamp is the version info compiled into a binary.
type stamp struct{ Version, Commit, Time string }

func newStamp(b *engine.BuildContext) (stamp, error) {
	s := stamp{Version: b.Version, Commit: b.Commit, Time: buildTime()}
	for _, v := range []string{s.Version, s.Commit} {
		if v == "" || strings.ContainsAny(v, " \t\r\n'\"\\$`") {
			return s, fmt.Errorf("%s: cannot stamp %q into a build", b.Unit, v)
		}
	}
	return s, nil
}

// ldflags builds the -ldflags value: strip plus one -X per symbol.
func (s stamp) ldflags(version, commit, when string) string {
	return fmt.Sprintf("-s -w -X %s=%s -X %s=%s -X %s=%s", version, s.Version, commit, s.Commit, when, s.Time)
}

// checkStampScript is run in the go image after a build. Arguments:
// binary version commit time workdir pkg symbol... A -X flag aimed at a
// symbol that does not exist is silently ignored by Go (that is how Sol
// shipped "dev" binaries), and the build info does not record ldflags, so it
// checks that every stamped symbol is a package-level var and that the stamped strings are
// in the binary. The commit and time are unique strings, so finding them
// proves the -X flags took effect.
const checkStampScript = `set -eu
bin=$1; ver=$2; commit=$3; when=$4; dir=$5; pkg=$6; shift 6
cd "$dir"
for sym in "$@"; do
  out=$(go doc -u -cmd "$pkg" "$sym" 2>&1) || { echo "stamp check: $pkg has no symbol $sym: $out" >&2; exit 1; }
  # go doc also matches methods; -X needs a package-level string var.
  printf '%s\n' "$out" | grep -Eq "^[[:space:]]*(var[[:space:]]+)?$sym[[:space:]]+(string[[:space:]]+)?=" \
    || { echo "stamp check: $pkg.$sym is not a package-level var with a string value" >&2; exit 1; }
done
# EXPECT_ARCH: the ELF header's machine type (bytes 18-19) must be the target's.
if [ -n "${EXPECT_ARCH:-}" ]; then
  case "$EXPECT_ARCH" in amd64) want="3e 00" ;; arm64) want="b7 00" ;; *) echo "stamp check: unknown arch $EXPECT_ARCH" >&2; exit 1 ;; esac
  got=$(od -An -tx1 -j18 -N2 "$bin" | tr -s ' ' | sed 's/^ //;s/ $//')
  [ "$(head -c4 "$bin" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ] && [ "$got" = "$want" ] \
    || { echo "stamp check: $bin is not a linux/$EXPECT_ARCH executable (ELF machine $got)" >&2; exit 1; }
fi
for v in "$ver" "$commit" "$when"; do
  grep -aqF -- "$v" "$bin" || { echo "stamp check: $v is not compiled into $bin" >&2; exit 1; }
done
echo "stamp check: $bin reports $ver ($commit)"
`

// cacheRoot is the host cache dir (engine's, or the default when the build
// context has no engine, as in graph-shape tests).
func cacheRoot(b *engine.BuildContext) string {
	if b.Engine != nil {
		return b.Engine.CacheDir()
	}
	d, err := engine.DefaultCacheDir()
	if err != nil {
		return filepath.Join(os.TempDir(), "libreserv-release")
	}
	return d
}

// freshDir removes and recreates dir, so a rebuild never mixes old output in.
func freshDir(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

// srcPath is a path inside the container's /src.
func srcPath(rel string) string { return "/src/" + rel }

// nodeBuildScript installs an app's dependencies (skipped while package.json
// and the lockfile are unchanged, so a warm node_modules volume is reused),
// optionally the shared UI's too, then runs `npm run build`.
// Arguments: dist app shared node-image. The node image's reference is part of
// the "installed" key, so a new Node (or npm) reinstalls instead of reusing
// modules built by the old one. The shared UI needs its own node_modules: the
// app links it by symlink, so its imports resolve from its real path.
const nodeBuildScript = `set -eu
img=${4:-}
install() {
  cd "$1"
  h=$( { cat package.json package-lock.json; printf 'node-image=%s\n' "$img"; } | sha256sum | cut -d' ' -f1)
  if [ "$(cat node_modules/.release-hash 2>/dev/null)" != "$h" ]; then
    rm -f node_modules/.release-hash
    npm ci --no-audit --no-fund
    echo "$h" > node_modules/.release-hash
  fi
}
dist=$1; app=$2; shared=$3
if [ -n "$shared" ]; then install "$shared"; fi
install "$app"
cd "$app"
npm run build
test -f "$dist/index.html"
`

// viteBuild is a RunSpec that builds the Vite app at appRel (relative to the
// repo root) into hostDist. Nothing is written to the source export except
// through mounts: node_modules is a named volume, and hostDist is mounted over
// the app's output dir (dist is the app's outDir inside the export).
// node_modules volumes are named by key so parallel jobs never share one.
func viteBuild(b *engine.BuildContext, key, appRel, distRel, hostDist string, sharedUI bool) engine.RunSpec {
	caches := []engine.Cache{
		engine.CacheNpm,
		{Volume: "node-modules-" + key, Target: srcPath(appRel + "/node_modules")},
	}
	shared := ""
	if sharedUI {
		shared = srcPath("shared/ui")
		caches = append(caches, engine.Cache{Volume: "node-modules-shared-ui-" + key, Target: srcPath("shared/ui/node_modules")})
	}
	dist := srcPath(distRel)
	return engine.RunSpec{
		Image:  "node",
		Source: b.SrcDir,
		Memory: buildMemory,
		Caches: caches,
		Mounts: []engine.Mount{{Host: hostDist, Target: dist}},
		Cmd:    []string{"sh", "-c", nodeBuildScript, "sh", dist, srcPath(appRel), shared, nodeImageRef(b)},
	}
}

// nodeImageRef is the local reference of the node toolchain image (its name
// carries a hash of its Containerfile), or "" when no engine is attached.
func nodeImageRef(b *engine.BuildContext) string {
	if b.Engine == nil {
		return ""
	}
	img, err := b.Engine.LoadImage("node")
	if err != nil {
		return ""
	}
	return img.Ref()
}

// goTarget selects a static linux build for arch. Plain values go on the
// command line (not through the process environment, which a wrapped podman
// may not pass on); only secrets use RunSpec.Env.
func goTarget(arch string) []string {
	return []string{"-e", "GOOS=linux", "-e", "GOARCH=" + arch, "-e", "CGO_ENABLED=0"}
}

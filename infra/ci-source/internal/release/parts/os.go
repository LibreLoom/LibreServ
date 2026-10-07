package parts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func init() {
	o := &osBuilder{plans: map[*engine.BuildContext]*osPlan{}}
	Register("luna", &osPart{o, "os"}, &osPart{o, "installer"})
}

// File names, exactly as in the plan's parts table.
const (
	OSFile        = "luna-os-x86_64.img.xz"
	InstallerFile = "luna-rapidinstall-x86_64.iso.xz"
	// InputsSuffix names the sidecar that records what a file was built from.
	// It is uploaded next to the file, so the next release can tell whether
	// the file must be built again.
	InputsSuffix = ".inputs"

	osHashJob     = "luna/os:hash"
	osRootfsJob   = "luna/os:rootfs"
	osImageJob    = "luna/os:image"
	OSJob         = "luna/os"
	instLiveJob   = "luna/installer:live"
	instISOJob    = "luna/installer:iso"
	InstallerJob  = "luna/installer"
	osRootfsCache = "luna-os-rootfs"
)

// How a part's file comes about in this build.
type osAction int

const (
	osBuild  osAction = iota // build it
	osReuse                  // the last release already ships it: produce nothing
	osCached                 // an earlier local build has it: link it into the output
)

func (a osAction) String() string { return [...]string{"build", "reuse", "cached"}[a] }

// osPlan is what the hash job decided; the later jobs of both parts read it.
type osPlan struct {
	mu sync.Mutex
	// osHash is the OS input hash, isoKey what the installer is made from.
	osHash, isoKey string
	os, inst       osAction
	// osRel is the released image the installer embeds when this build does
	// not make one (os is osReuse).
	osRel   engine.Released
	decided bool
}

// osBuilder holds the plans of the builds in flight. The os and installer
// parts share it: the installer needs the OS decision.
type osBuilder struct {
	mu    sync.Mutex
	plans map[*engine.BuildContext]*osPlan
}

func (o *osBuilder) plan(b *engine.BuildContext) *osPlan {
	o.mu.Lock()
	defer o.mu.Unlock()
	p := o.plans[b]
	if p == nil {
		p = &osPlan{}
		o.plans[b] = p
	}
	return p
}

// osPart is "os" (the slot image) or "installer" (the rapidinstall ISO).
type osPart struct {
	o    *osBuilder
	name string
}

func (p *osPart) Name() string { return p.name }
func (*osPart) Unit() string   { return "luna" }

func (p *osPart) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	if p.name == "os" {
		return p.o.osJobs(b), nil
	}
	return p.o.installerJobs(b), nil
}

// logFunc is JobRun.Logf.
type logFunc func(format string, a ...any)

// osHTTP downloads released files. Tests replace it.
var osHTTP = &http.Client{}

func (o *osBuilder) osJobs(b *engine.BuildContext) []engine.Job {
	pl := o.plan(b)
	// The skip decision belongs to the hash job (it runs first, and is cheap);
	// the rest of the chain only follows it.
	action := func() osAction { pl.mu.Lock(); defer pl.mu.Unlock(); return pl.os }
	return []engine.Job{
		{ID: osHashJob, Title: "Luna OS inputs",
			Run: func(ctx context.Context, j *engine.JobRun) error { return o.decide(ctx, b, j, pl) }},
		{ID: osRootfsJob, Title: "Luna OS root filesystem", Heavy: true, Deps: []string{osHashJob, LunadJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				if a := action(); a != osBuild {
					j.Logf("skipped: the OS image is %s", a)
					return nil
				}
				spec, err := osRootfsSpec(b)
				if err != nil {
					return err
				}
				return j.Container(ctx, spec)
			}},
		{ID: osImageJob, Title: "Luna OS image", Heavy: true, Deps: []string{osRootfsJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				if action() != osBuild {
					return nil
				}
				pl.mu.Lock()
				hash := pl.osHash
				pl.mu.Unlock()
				spec, err := osImageSpec(b, hash)
				if err != nil {
					return err
				}
				return j.Container(ctx, spec)
			}},
		{ID: OSJob, Title: "Luna OS " + b.Version, Deps: []string{osImageJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				pl.mu.Lock()
				act, hash := pl.os, pl.osHash
				pl.mu.Unlock()
				return finishFile(b, j.Logf, "os", OSFile, "luna-os", hash, act, osSidecars(OSFile))
			}},
	}
}

func (o *osBuilder) installerJobs(b *engine.BuildContext) []engine.Job {
	pl := o.plan(b)
	action := func() osAction { pl.mu.Lock(); defer pl.mu.Unlock(); return pl.inst }
	return []engine.Job{
		{ID: instLiveJob, Title: "Installer live system", Heavy: true, Deps: []string{osHashJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				if a := action(); a != osBuild {
					j.Logf("skipped: the installer is %s", a)
					return nil
				}
				return j.Container(ctx, instLiveSpec(b))
			}},
		{ID: instISOJob, Title: "Installer ISO", Heavy: true, Deps: []string{instLiveJob, OSJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				if action() != osBuild {
					return nil
				}
				payload, err := o.payload(ctx, b, j, pl)
				if err != nil {
					return err
				}
				spec, err := instISOSpec(b, payload)
				if err != nil {
					return err
				}
				return j.Container(ctx, spec)
			}},
		{ID: InstallerJob, Title: "Installer " + b.Version, Deps: []string{instISOJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				pl.mu.Lock()
				act, key := pl.inst, pl.isoKey
				pl.mu.Unlock()
				return finishFile(b, j.Logf, "installer", InstallerFile, "luna-installer", key, act, osSidecars(InstallerFile))
			}},
	}
}

// ---- the decision

// osInputs reads what the OS image and the installer are made from.
func (o *osBuilder) decide(ctx context.Context, b *engine.BuildContext, j *engine.JobRun, pl *osPlan) error {
	hash, err := osInputHash(ctx, b, j)
	if err != nil {
		return err
	}
	packs := osPacks(b)
	key, err := installerKey(filepath.Join(b.SrcDir, "luna", "os"), hash, packs)
	if err != nil {
		return err
	}
	j.Logf("OS inputs %s, installer inputs %s", hash[:12], key[:12])
	for _, p := range []string{"eurooffice-pack.tar.zst", "drawio-pack.tar.zst"} {
		if !containsBase(packs, p) {
			j.Logf("warning: no %s in %s: devices installed from this ISO will lack that editor", p, packsDir(b))
		}
	}

	osRel, haveOS := engine.Released{}, false
	if b.Released != nil {
		osRel, haveOS = b.Released("os")
	}
	osAct, why := decide(decideIn{
		force: b.Rebuild || b.Named("os"),
		hash:  hash,
		released: func() (string, error) {
			if !haveOS {
				return "", errors.New("no earlier release has an OS image")
			}
			return fetchInputs(ctx, osRel.URL)
		},
		releasedVersion: osRel.Version,
		cached:          cacheHas(b, "luna-os", hash, OSFile),
	})
	j.Logf("OS image: %s (%s)", osAct, why)

	instAct, why := decide(decideIn{
		force: b.Rebuild || b.Named("installer"),
		hash:  key,
		released: func() (string, error) {
			if b.Released == nil {
				return "", errors.New("not a release build")
			}
			r, ok := b.Released("installer")
			if !ok {
				return "", errors.New("no earlier release has an installer")
			}
			return fetchInputs(ctx, r.URL)
		},
		releasedVersion: func() string {
			if b.Released == nil {
				return ""
			}
			r, _ := b.Released("installer")
			return r.Version
		}(),
		cached: cacheHas(b, "luna-installer", key, InstallerFile),
	})
	j.Logf("installer: %s (%s)", instAct, why)

	pl.mu.Lock()
	defer pl.mu.Unlock()
	pl.osHash, pl.isoKey, pl.os, pl.inst, pl.osRel, pl.decided = hash, key, osAct, instAct, osRel, true
	return nil
}

// decideIn is everything decide looks at.
type decideIn struct {
	force bool
	hash  string
	// released returns the input hash recorded with the newest released file.
	released        func() (string, error)
	releasedVersion string
	cached          bool
}

// decide picks what to do about one file, and says why in plain words.
//
//	named in --parts or forced      -> build
//	same inputs as the last release -> reuse (build nothing, the feed keeps pointing at it)
//	same inputs as an earlier local build -> cached (link it)
//	otherwise                       -> build
func decide(in decideIn) (osAction, string) {
	if in.force {
		return osBuild, "asked for"
	}
	note := ""
	if in.released != nil {
		got, err := in.released()
		switch {
		case err == nil && got == in.hash:
			return osReuse, "unchanged since " + in.releasedVersion
		case err == nil:
			note = "changed since " + in.releasedVersion
		default:
			note = "cannot compare with the last release: " + err.Error()
		}
	}
	if in.cached {
		return osCached, "built before from the same inputs"
	}
	if note == "" {
		note = "no earlier build"
	}
	return osBuild, note
}

func osInputHash(ctx context.Context, b *engine.BuildContext, j *engine.JobRun) (string, error) {
	dir, err := lunaWorkDir(b, "os-hash")
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, "os-input-hash")
	os.Remove(out)
	spec := lunaShell(engine.RunSpec{
		Name:    "luna-os-hash",
		Image:   "luna-os",
		Mounts:  []engine.Mount{osSrcMount(b), {Host: dir, Target: "/w"}},
		Env:     osEnv(),
		Network: "none",
		Memory:  "256m",
	}, "sh", "os-hash.sh")
	if err := j.Container(ctx, spec); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		return "", err
	}
	h := strings.TrimSpace(string(raw))
	if len(h) != 64 || strings.Trim(h, "0123456789abcdef") != "" {
		return "", fmt.Errorf("input-hash.sh printed %q, not a sha256", h)
	}
	return h, nil
}

// osEnv passes through the knobs input-hash.sh and the build steps read, so a
// forced refresh or a pinned Alpine behaves as with the dev wrappers.
func osEnv() map[string]string {
	env := map[string]string{}
	for _, k := range []string{"LUNA_OS_REFRESH", "ALPINE_VERSION", "CLOUDFLARED_VERSION", "ALPINE_IMAGE", "SIZE_MB"} {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
	}
	return env
}

// installerKey hashes what the ISO is made from besides the OS image's own
// inputs: the live system, the installer scripts and the packs.
func installerKey(osDir, osHash string, packs []string) (string, error) {
	var files []string
	add := func(rel string) error {
		st, err := os.Stat(filepath.Join(osDir, rel))
		if err != nil {
			return err
		}
		if !st.IsDir() {
			files = append(files, rel)
			return nil
		}
		return filepath.WalkDir(filepath.Join(osDir, rel), func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type().IsRegular() {
				r, _ := filepath.Rel(osDir, p)
				files = append(files, filepath.ToSlash(r))
			}
			return nil
		})
	}
	for _, rel := range []string{"debian-live/config", "iso/find-media.sh", "rapidinstall.sh",
		"lib/disk.sh", "lib/flash-disk.sh", "lib/console.sh", "lib/factory-assets.sh",
		"build/iso.sh", "build/live.sh", "build/iso-customize.sh", "build/Containerfile.iso"} {
		if err := add(rel); err != nil {
			return "", err
		}
	}
	sort.Strings(files)
	h := sha256.New()
	fmt.Fprintf(h, "os=%s\nlive_refresh=%s\n", osHash, os.Getenv("LUNA_LIVE_REFRESH"))
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(osDir, filepath.FromSlash(f)))
		if err != nil {
			return "", err
		}
		fmt.Fprintf(h, "file=%s %x\n", f, sha256.Sum256(b))
	}
	for _, p := range packs {
		fmt.Fprintf(h, "pack=%s\n", filepath.Base(p))
		if strings.HasSuffix(p, ".sha256") {
			b, err := os.ReadFile(p)
			if err != nil {
				return "", err
			}
			fmt.Fprintf(h, "%s\n", strings.TrimSpace(string(b)))
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// packsDir is where the EuroOffice and draw.io packs are looked for:
// LUNA_PACKS_DIR, else <cache>/luna-packs.
func packsDir(b *engine.BuildContext) string {
	if d := os.Getenv("LUNA_PACKS_DIR"); d != "" {
		return d
	}
	return filepath.Join(b.Engine.CacheDir(), "luna-packs")
}

// osPacks lists the pack files (each tarball and its .sha256) found in packsDir.
func osPacks(b *engine.BuildContext) []string {
	var out []string
	for _, n := range []string{"eurooffice-pack.tar.zst", "drawio-pack.tar.zst"} {
		p := filepath.Join(packsDir(b), n)
		if fileOK(p) && fileOK(p+".sha256") {
			out = append(out, p, p+".sha256")
		}
	}
	return out
}

func containsBase(paths []string, base string) bool {
	for _, p := range paths {
		if filepath.Base(p) == base {
			return true
		}
	}
	return false
}

// fetchInputs reads the .inputs file stored next to a released file.
func fetchInputs(ctx context.Context, fileURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL+InputsSuffix, nil)
	if err != nil {
		return "", err
	}
	resp, err := osHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the last release has no %s (HTTP %d)", filepath.Base(fileURL)+InputsSuffix, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return strings.TrimSpace(string(b)), err
}

// ---- local cache of finished files, keyed by their inputs

func cacheDirFor(b *engine.BuildContext, kind, key string) string {
	return filepath.Join(b.Engine.CacheDir(), kind, key)
}

func cacheHas(b *engine.BuildContext, kind, key, file string) bool {
	return fileOK(filepath.Join(cacheDirFor(b, kind, key), file))
}

func fileOK(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

func osSidecars(file string) []string { return []string{file + InputsSuffix} }

// finishFile closes a part: after a build it records the inputs next to the
// file and keeps a copy in the cache (only the newest per kind); for a cached
// file it links the copy into the output; for a reused one it does nothing.
func finishFile(b *engine.BuildContext, logf logFunc, part, file, kind, key string, act osAction, sidecars []string) error {
	out := b.PartOutDir(part)
	dst := filepath.Join(out, file)
	switch act {
	case osReuse:
		logf("%s: not built, the last release's file stays in the feed", file)
		return nil
	case osCached:
		dir := cacheDirFor(b, kind, key)
		if err := os.MkdirAll(out, 0o755); err != nil {
			return err
		}
		for _, n := range append([]string{file}, sidecars...) {
			src := filepath.Join(dir, n)
			if !fileOK(src) {
				continue
			}
			if err := linkFile(src, filepath.Join(out, n)); err != nil {
				return err
			}
		}
		logf("%s: linked from the cache (%s)", file, dir)
		return nil
	}
	if !fileOK(dst) {
		return fmt.Errorf("%s was not produced in %s", file, out)
	}
	// image.sh writes its own .inputs; the installer has none yet.
	if err := os.WriteFile(dst+InputsSuffix, []byte(key+"\n"), 0o644); err != nil {
		return err
	}
	dir := cacheDirFor(b, kind, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, n := range append([]string{file}, sidecars...) {
		if err := linkFile(filepath.Join(out, n), filepath.Join(dir, n)); err != nil {
			return err
		}
	}
	// Keep only the newest of each kind: these files are hundreds of MB.
	ents, _ := os.ReadDir(filepath.Dir(dir))
	for _, e := range ents {
		if e.IsDir() && e.Name() != key {
			os.RemoveAll(filepath.Join(filepath.Dir(dir), e.Name()))
		}
	}
	st, _ := os.Stat(dst)
	logf("%s (%d bytes)", dst, st.Size())
	return nil
}

// linkFile hard-links src at dst (no second copy of a multi-GB file), or
// copies when they sit on different filesystems.
func linkFile(src, dst string) error {
	os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// ---- the installer's payload

// payload fills the directory iso.sh embeds: the exact .img.xz this release
// ships (built or cached now, or the last release's, fetched and checked
// against the feed) with its .sha256, and the packs when present.
func (o *osBuilder) payload(ctx context.Context, b *engine.BuildContext, j *engine.JobRun, pl *osPlan) (string, error) {
	dir, err := lunaWorkDir(b, "installer-payload")
	if err != nil {
		return "", err
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		os.RemoveAll(filepath.Join(dir, e.Name()))
	}
	pl.mu.Lock()
	act, rel := pl.os, pl.osRel
	pl.mu.Unlock()

	img := filepath.Join(dir, OSFile)
	var sum string
	if act == osReuse {
		cached, err := fetchReleased(ctx, b, j.Logf, rel)
		if err != nil {
			return "", err
		}
		if err := linkFile(cached, img); err != nil {
			return "", err
		}
		sum = rel.SHA256
	} else {
		built := filepath.Join(b.PartOutDir("os"), OSFile)
		if !fileOK(built) {
			return "", fmt.Errorf("%s is missing: the OS image was not built", built)
		}
		if err := linkFile(built, img); err != nil {
			return "", err
		}
		if sum, err = sha256File(img); err != nil {
			return "", err
		}
	}
	if err := os.WriteFile(img+".sha256", []byte(sum+"  "+OSFile+"\n"), 0o644); err != nil {
		return "", err
	}
	for _, p := range osPacks(b) {
		if err := linkFile(p, filepath.Join(dir, filepath.Base(p))); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// fetchReleased downloads a released file into the cache (once) and checks it
// against the sha256 the feed lists, so a damaged or swapped download never
// ends up inside an ISO.
func fetchReleased(ctx context.Context, b *engine.BuildContext, logf logFunc, r engine.Released) (string, error) {
	if len(r.SHA256) != 64 {
		return "", errors.New("the feed lists no sha256 for the released OS image")
	}
	dir := filepath.Join(b.Engine.CacheDir(), "luna-released")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, r.SHA256+".img.xz")
	if got, err := sha256File(dst); err == nil && got == r.SHA256 {
		return dst, nil
	}
	logf("downloading the released OS image %s", r.Version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		return "", err
	}
	resp, err := osHTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: HTTP %d", r.URL, resp.StatusCode)
	}
	tmp, err := os.CreateTemp(dir, ".dl-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != r.SHA256 {
		return "", fmt.Errorf("the released OS image does not match the feed (sha256 %s, expected %s)", got, r.SHA256)
	}
	if r.Size > 0 && n != r.Size {
		return "", fmt.Errorf("the released OS image is %d bytes, the feed says %d", n, r.Size)
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return "", err
	}
	// Older downloads are not needed any more.
	if old, _ := filepath.Glob(filepath.Join(dir, "*.img.xz")); len(old) > 0 {
		for _, o := range old {
			os.Remove(o)
		}
	}
	return dst, os.Rename(tmp.Name(), dst)
}

func sha256File(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ---- container specs

func osSrcMount(b *engine.BuildContext) engine.Mount {
	return engine.Mount{Host: filepath.Join(b.SrcDir, "luna", "os"), Target: "/luna/os", ReadOnly: true}
}

func osRootfsSpec(b *engine.BuildContext) (engine.RunSpec, error) {
	lunad := b.PartOutDir("lunad")
	console := filepath.Dir(LunaConsolePath(b))
	for _, p := range []string{filepath.Join(lunad, LunadFile), LunaConsolePath(b)} {
		if !fileOK(p) {
			return engine.RunSpec{}, fmt.Errorf("%s is missing: lunad must be built first", p)
		}
	}
	env := osEnv()
	env["LUNA_CACHE_DIR"] = "/cache"
	env["LUNAD_BIN"] = "/in/lunad/" + LunadFile
	env["LUNA_CONSOLE_BIN"] = "/in/console/" + lunaConsoleName
	return (engine.RunSpec{
		Name:  "luna-os-rootfs",
		Image: "luna-os",
		Mounts: []engine.Mount{osSrcMount(b),
			{Host: lunad, Target: "/in/lunad", ReadOnly: true},
			{Host: console, Target: "/in/console", ReadOnly: true}},
		Caches: []engine.Cache{{Volume: osRootfsCache, Target: "/rootfs"}, {Volume: "luna-os-cache", Target: "/cache"}},
		Env:    env,
		Memory: "3g",
		Cmd:    []string{"sh", "/luna/os/build/rootfs.sh"},
	}), nil
}

func osImageSpec(b *engine.BuildContext, hash string) (engine.RunSpec, error) {
	out := b.PartOutDir("os")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return engine.RunSpec{}, err
	}
	env := osEnv()
	env["OS_INPUT_HASH"] = hash
	return (engine.RunSpec{
		Name:   "luna-os-image",
		Image:  "luna-os",
		Out:    out,
		Mounts: []engine.Mount{osSrcMount(b)},
		Caches: []engine.Cache{{Volume: osRootfsCache, Target: "/rootfs"}},
		Env:    env,
		Memory: "3g",
		Cmd:    []string{"sh", "/luna/os/build/image.sh"},
	}), nil
}

func instEnv() map[string]string {
	env := map[string]string{}
	if v := os.Getenv("LUNA_LIVE_REFRESH"); v != "" {
		env["LUNA_LIVE_REFRESH"] = v
	}
	return env
}

func instLiveSpec(b *engine.BuildContext) engine.RunSpec {
	env := instEnv()
	env["LIVE_ONLY"] = "1"
	return (engine.RunSpec{
		Name:   "luna-live",
		Image:  "luna-iso",
		Mounts: []engine.Mount{osSrcMount(b)},
		Caches: []engine.Cache{{Volume: "luna-iso-cache", Target: "/cache"}},
		Env:    env,
		Memory: "3g",
		Cmd:    []string{"sh", "/luna/os/build/iso.sh"},
	})
}

func instISOSpec(b *engine.BuildContext, payload string) (engine.RunSpec, error) {
	out := b.PartOutDir("installer")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return engine.RunSpec{}, err
	}
	return lunaShell(engine.RunSpec{
		Name:   "luna-iso",
		Image:  "luna-iso",
		Out:    out,
		Mounts: []engine.Mount{osSrcMount(b), {Host: payload, Target: "/payload", ReadOnly: true}},
		Caches: []engine.Cache{{Volume: "luna-iso-cache", Target: "/cache"}},
		Env:    instEnv(),
		Memory: "3g",
	}, "sh", "os-iso.sh"), nil
}

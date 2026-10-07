// Package engine is the release tool's build engine: toolchain images, a
// rootless container runner with named-volume caches, `git archive` source
// export, a parallel job graph, and log redaction. It knows nothing about
// Sol or Luna; parts plug in through the Part and Job types.
package engine

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// LogFunc receives one log line (no trailing newline), already redacted.
type LogFunc func(line string)

// Config configures an Engine.
type Config struct {
	// Podman is the podman binary (default "podman").
	Podman string
	// Repo is the git checkout sources are exported from.
	Repo string
	// ImagesDir holds <name>/Containerfile (default <Repo>/infra/release/images).
	ImagesDir string
	// CacheDir is the host cache root (default ~/.cache/libreserv-release).
	CacheDir string
	// Redactor scrubs every log line; may be nil (a fresh one is created).
	Redactor *Redactor
}

// Engine runs images and containers. Safe for concurrent use.
type Engine struct {
	cfg      Config
	Redactor *Redactor

	imgMu   sync.Mutex
	imgLock map[string]*sync.Mutex
	counter uint64
	cntMu   sync.Mutex
}

// New fills in defaults and returns an Engine.
func New(cfg Config) (*Engine, error) {
	if cfg.Podman == "" {
		cfg.Podman = "podman"
	}
	if cfg.ImagesDir == "" && cfg.Repo != "" {
		cfg.ImagesDir = filepath.Join(cfg.Repo, "infra", "release", "images")
	}
	if cfg.CacheDir == "" {
		d, err := DefaultCacheDir()
		if err != nil {
			return nil, err
		}
		cfg.CacheDir = d
	}
	if cfg.Redactor == nil {
		cfg.Redactor = &Redactor{}
	}
	return &Engine{cfg: cfg, Redactor: cfg.Redactor, imgLock: map[string]*sync.Mutex{}}, nil
}

// Config returns the effective configuration.
func (e *Engine) Config() Config { return e.cfg }

// CacheDir is the host cache root.
func (e *Engine) CacheDir() string { return e.cfg.CacheDir }

// Export exports ref of the engine's repo to the source cache (see ExportSource).
func (e *Engine) Export(ctx context.Context, ref string) (dir, sha string, err error) {
	return ExportSource(ctx, e.cfg.Repo, ref, e.cfg.CacheDir)
}

// PodmanOutput runs podman and returns stdout (for short queries).
func (e *Engine) PodmanOutput(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, e.cfg.Podman, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return strings.TrimSpace(out.String()), fmt.Errorf("podman %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// ImageExists reports whether the local image ref exists.
func (e *Engine) ImageExists(ctx context.Context, ref string) bool {
	return exec.CommandContext(ctx, e.cfg.Podman, "image", "exists", ref).Run() == nil
}

// LoadImage loads an image definition by name from ImagesDir.
func (e *Engine) LoadImage(name string) (Image, error) { return LoadImage(e.cfg.ImagesDir, name) }

// ListImages loads every image definition.
func (e *Engine) ListImages() ([]Image, error) { return ListImages(e.cfg.ImagesDir) }

// BuildOpts tune EnsureImage.
type BuildOpts struct {
	// Pull refreshes base images (`--pull=always`) and forces a rebuild.
	Pull bool
	// NoCache ignores layer cache and forces a rebuild.
	NoCache bool
}

// EnsureImage builds the image if its content-hash tag is missing (or
// forced by opts) and returns it. Concurrent calls for one image build once.
func (e *Engine) EnsureImage(ctx context.Context, name string, opts BuildOpts, log LogFunc) (Image, error) {
	img, err := e.LoadImage(name)
	if err != nil {
		return img, err
	}
	e.imgMu.Lock()
	mu := e.imgLock[name]
	if mu == nil {
		mu = &sync.Mutex{}
		e.imgLock[name] = mu
	}
	e.imgMu.Unlock()
	mu.Lock()
	defer mu.Unlock()

	forced := opts.Pull || opts.NoCache
	if !forced && e.ImageExists(ctx, img.Ref()) {
		return img, nil
	}
	if log == nil {
		log = func(string) {}
	}
	log(fmt.Sprintf("building image %s", img.Ref()))
	args := []string{"build", "--layers", "--tag", img.Ref(), "--label", "libreserv-release.image=" + name}
	if opts.Pull {
		args = append(args, "--pull=always")
	}
	if opts.NoCache {
		args = append(args, "--no-cache")
	}
	args = append(args, img.Dir)
	if err := e.stream(ctx, exec.CommandContext(ctx, e.cfg.Podman, args...), "", log); err != nil {
		return img, fmt.Errorf("build image %s: %w", name, err)
	}
	return img, nil
}

// Cache is a named podman volume mounted into a job.
type Cache struct {
	Volume string // without the libreserv-release- prefix
	Target string // path inside the container
}

// VolumePrefix is prepended to every cache volume name. The environment variable
// LIBRESERV_RELEASE_VOLUME_PREFIX swaps in a separate set of caches (for example
// to time a cold build without touching the real ones).
var VolumePrefix = volumePrefix()

func volumePrefix() string {
	if p := os.Getenv("LIBRESERV_RELEASE_VOLUME_PREFIX"); p != "" {
		return p
	}
	return "libreserv-release-"
}

// Well-known caches. Targets match the toolchain images' homes.
var (
	CacheCargoRegistry = Cache{"cargo-registry", "/usr/local/cargo/registry"}
	CacheCargoGit      = Cache{"cargo-git", "/usr/local/cargo/git"}
	CacheGoMod         = Cache{"gomod", "/go/pkg/mod"}
	CacheGoBuild       = Cache{"gobuild", "/root/.cache/go-build"}
	CacheNpm           = Cache{"npm", "/root/.npm"}
	CacheGradle        = Cache{"gradle", "/root/.gradle"}
	CacheFlatpak       = Cache{"flatpak-builder", "/root/.local/share/flatpak-builder"}
)

// CargoCaches returns the cargo registry, git cache, and a per-target
// `target/` volume mounted at targetDir (e.g. "/src/luna/target").
func CargoCaches(targetName, targetDir string) []Cache {
	return []Cache{CacheCargoRegistry, CacheCargoGit, {"target-" + targetName, targetDir}}
}

// GoCaches returns the Go module and build caches.
func GoCaches() []Cache { return []Cache{CacheGoMod, CacheGoBuild} }

// Mount is a host directory mounted into a job.
type Mount struct {
	Host, Target string
	ReadOnly     bool
}

// RunSpec describes one container run.
type RunSpec struct {
	// Name labels the run (log prefix, container name stem).
	Name string
	// Image is a toolchain image name from ImagesDir ("go", "node", ...).
	Image string
	// Cmd is the command and args run in the image.
	Cmd []string
	// Env is passed in a 0600 env file (--env-file), never argv, so secrets
	// stay out of `ps`. Values must be single-line.
	Env map[string]string
	// Workdir inside the container (default /src when Source is set).
	Workdir string
	// Source is a host dir mounted writable at /src (usually the export dir).
	Source string
	// Out is a host dir mounted writable at /out (the part's output dir).
	Out string
	// Caches are named volumes (see Cache*).
	Caches []Cache
	// Mounts are extra host mounts.
	Mounts []Mount
	// Memory is the --memory limit, e.g. "4g". Empty means no limit.
	Memory string
	// ExtraOpts are extra `podman run` args on top of the image's run-options.
	ExtraOpts []string
	// Network is "" (default) or "none" etc.
	Network string
}

// ExitError is returned when the container command exits non-zero.
type ExitError struct {
	Code int
	Name string
}

func (e *ExitError) Error() string { return fmt.Sprintf("%s exited with status %d", e.Name, e.Code) }

// Run builds the spec's image if needed, then runs the command rootless,
// streaming each output line (stdout+stderr merged, redacted) to log.
// Cancelling ctx kills the container.
func (e *Engine) Run(ctx context.Context, spec RunSpec, log LogFunc) error {
	if log == nil {
		log = func(string) {}
	}
	img, err := e.EnsureImage(ctx, spec.Image, BuildOpts{}, log)
	if err != nil {
		return err
	}
	name := e.containerName(spec.Name)
	envFile, err := e.writeEnvFile(spec.Env)
	if err != nil {
		return err
	}
	if envFile != "" {
		defer os.Remove(envFile)
	}
	args := e.runArgs(img, spec, name, envFile)

	cmd := exec.CommandContext(ctx, e.cfg.Podman, args...)
	cmd.Cancel = func() error {
		kill := exec.Command(e.cfg.Podman, "kill", "--signal", "KILL", name)
		kill.Run()
		return cmd.Process.Signal(syscall.SIGTERM)
	}
	cmd.WaitDelay = 15 * time.Second
	err = e.stream(ctx, cmd, spec.Name, log)
	if ctx.Err() != nil {
		exec.Command(e.cfg.Podman, "rm", "-f", "--ignore", name).Run()
		return ctx.Err()
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return &ExitError{Code: ee.ExitCode(), Name: spec.Name}
	}
	return err
}

func (e *Engine) containerName(stem string) string {
	e.cntMu.Lock()
	e.counter++
	n := e.counter
	e.cntMu.Unlock()
	clean := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			return r
		}
		return '-'
	}, stem)
	return fmt.Sprintf("lsr-%s-%d-%d", clean, os.Getpid(), n)
}

// writeEnvFile writes spec env to a 0600 file under the cache dir for
// `--env-file`. Values never go on argv, and unlike `-e NAME` (podman reading
// its own environment) this survives podman wrappers such as distrobox's
// host-spawn, which don't forward the caller's environment.
func (e *Engine) writeEnvFile(env map[string]string) (string, error) {
	if len(env) == 0 {
		return "", nil
	}
	keys := make([]string, 0, len(env))
	for k := range env {
		if strings.ContainsAny(env[k], "\n\r") {
			return "", fmt.Errorf("env %s: value has a line break; mount it as a file instead", k)
		}
		keys = append(keys, k)
	}
	sortStrings(keys)
	dir := filepath.Join(e.cfg.CacheDir, "run")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "env-*")
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k + "=" + env[k] + "\n")
	}
	_, werr := f.WriteString(b.String())
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(f.Name())
		return "", werr
	}
	return f.Name(), nil
}

// RunArgs builds the `podman run` argv (exported for tests). Env values are
// not included, only their names; Run passes them in an env file instead.
func (e *Engine) RunArgs(img Image, spec RunSpec, name string) []string {
	return e.runArgs(img, spec, name, "")
}

func (e *Engine) runArgs(img Image, spec RunSpec, name, envFile string) []string {
	args := []string{"run", "--rm", "--name", name,
		"--label", "libreserv-release=1",
		// Mounts are plain bind mounts of user-owned dirs; relabelling a big
		// source tree for SELinux would be slow and is unnecessary.
		"--security-opt", "label=disable",
	}
	if spec.Memory != "" {
		args = append(args, "--memory", spec.Memory)
	}
	if spec.Network != "" {
		args = append(args, "--network", spec.Network)
	}
	wd := spec.Workdir
	if wd == "" && spec.Source != "" {
		wd = "/src"
	}
	if wd != "" {
		args = append(args, "--workdir", wd)
	}
	if spec.Source != "" {
		args = append(args, "-v", spec.Source+":/src")
	}
	if spec.Out != "" {
		args = append(args, "-v", spec.Out+":/out")
	}
	for _, c := range spec.Caches {
		args = append(args, "-v", VolumePrefix+c.Volume+":"+c.Target)
	}
	for _, m := range spec.Mounts {
		v := m.Host + ":" + m.Target
		if m.ReadOnly {
			v += ":ro"
		}
		args = append(args, "-v", v)
	}
	keys := make([]string, 0, len(spec.Env))
	for k := range spec.Env {
		keys = append(keys, k)
	}
	sortStrings(keys)
	if envFile != "" {
		args = append(args, "--env-file", envFile)
	} else {
		for _, k := range keys {
			args = append(args, "-e", k)
		}
	}
	args = append(args, img.RunOpts...)
	args = append(args, spec.ExtraOpts...)
	args = append(args, img.Ref())
	args = append(args, spec.Cmd...)
	return args
}

func sortStrings(s []string) { sort.Strings(s) }

// stream runs cmd and sends its merged output, line by line, through the
// redactor to log. Carriage-return progress updates count as lines.
func (e *Engine) stream(ctx context.Context, cmd *exec.Cmd, _ string, log LogFunc) error {
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
		sc.Split(splitLines)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			if line == "" {
				continue
			}
			log(e.Redactor.Redact(line))
		}
		io.Copy(io.Discard, pr)
	}()
	err := cmd.Run()
	pw.Close()
	<-done
	return err
}

// splitLines splits on \n and \r so progress bars become separate lines.
func splitLines(data []byte, atEOF bool) (int, []byte, error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		adv := i + 1
		if data[i] == '\r' && adv < len(data) && data[adv] == '\n' {
			adv++
		}
		return adv, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

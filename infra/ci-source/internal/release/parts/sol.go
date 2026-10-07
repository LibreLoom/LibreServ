package parts

import (
	"bufio"
	"compress/bzip2"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

const (
	solFrontendDir = "sol/server/frontend"
	solBackendDir  = "sol/server/backend"
	solPkgSystem   = "gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/system"

	resticVersion = "0.19.1"
)

// resticSums pins the sha256 of each official restic_<ver>_linux_<arch>.bz2
// (they match the SHA256SUMS file of the upstream release).
var resticSums = map[string]string{
	"amd64": "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c",
	"arm64": "a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465",
}

// resticBase is where restic releases are downloaded from (tests override it).
var resticBase = "https://github.com/restic/restic/releases/download"

// solArches are the architectures Sol ships, in feed order.
var solArches = []string{"amd64", "arm64"}

func init() {
	Register("sol", solWeb{}, solBinaries{})
}

// solWeb builds the React frontend once; both arches embed it. The vite
// output lands in <out>/dist, mounted over OS/dist in the export so the
// shared source tree is never written to.
type solWeb struct{}

func (solWeb) Name() string { return "web" }
func (solWeb) Unit() string { return "sol" }

// solWebDist is where the web job leaves the built frontend.
func solWebDist(b *engine.BuildContext) string { return filepath.Join(b.PartOutDir("web"), "dist") }

func (solWeb) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	dist := solWebDist(b)
	return []engine.Job{{
		ID:    "sol/web",
		Title: "Sol web UI",
		Run: func(ctx context.Context, j *engine.JobRun) error {
			if err := freshDir(dist); err != nil {
				return err
			}
			return j.Container(ctx, viteBuild(b, "sol-frontend", solFrontendDir, solBackendDir+"/OS/dist", dist, true))
		},
	}}, nil
}

// solBinaries builds libreserv-linux-<arch> for every arch: static, with the
// web UI and that arch's restic embedded and the version stamped in.
type solBinaries struct{}

func (solBinaries) Name() string { return "sol" }
func (solBinaries) Unit() string { return "sol" }

func solBinaryFile(arch string) string { return "libreserv-linux-" + arch }

func (solBinaries) Artifacts(b *engine.BuildContext) []Artifact {
	var out []Artifact
	for _, arch := range solArches {
		f := solBinaryFile(arch)
		out = append(out, Artifact{Unit: "sol", Part: "sol", OS: "linux", Arch: arch, File: f,
			Path: filepath.Join(b.PartOutDir("sol"), f)})
	}
	return out
}

func (solBinaries) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	st, err := newStamp(b)
	if err != nil {
		return nil, err
	}
	var jobs []engine.Job
	for _, arch := range solArches {
		arch := arch
		resticDir := resticCacheDir(cacheRoot(b), arch)
		buildID := "sol/sol:" + arch
		jobs = append(jobs,
			engine.Job{
				ID:    "sol/sol:restic-" + arch,
				Title: "restic " + resticVersion + " (" + arch + ")",
				Run: func(ctx context.Context, j *engine.JobRun) error {
					return fetchRestic(ctx, resticDir, arch, j.Logf)
				},
			},
			engine.Job{
				ID:    buildID,
				Title: "Sol " + arch,
				Deps:  []string{"sol/web", "sol/sol:restic-" + arch},
				Run: func(ctx context.Context, j *engine.JobRun) error {
					out := b.PartOutDir("sol")
					if err := os.MkdirAll(out, 0o755); err != nil {
						return err
					}
					file := solBinaryFile(arch)
					os.Remove(filepath.Join(out, file))
					workdir := srcPath(solBackendDir)
					err := j.Container(ctx, engine.RunSpec{
						Image:   "go",
						Source:  b.SrcDir,
						Out:     out,
						Workdir: workdir,
						Memory:  buildMemory,
						Caches:  engine.GoCaches(),
						Mounts: []engine.Mount{
							{Host: solWebDist(b), Target: srcPath(solBackendDir + "/OS/dist"), ReadOnly: true},
							{Host: resticDir, Target: srcPath(solBackendDir + "/OS/bin"), ReadOnly: true},
						},
						ExtraOpts: goTarget(arch),
						Cmd: []string{"go", "build", "-tags", "embedfront embedrestic",
							"-ldflags", st.ldflags(solPkgSystem+".Version", solPkgSystem+".GitCommit", solPkgSystem+".BuildTime"),
							"-o", "/out/" + file, "./cmd/libreserv"},
					})
					if err != nil {
						return err
					}
					return j.Container(ctx, engine.RunSpec{
						Name:   j.ID + "-check",
						Image:  "go",
						Source: b.SrcDir,
						Out:    out,
						Memory: "1g",
						Caches: engine.GoCaches(),
						Cmd: append([]string{"sh", "-c", checkStampScript, "sh", "/out/" + file,
							st.Version, st.Commit, st.Time, workdir, solPkgSystem},
							"Version", "GitCommit", "BuildTime"),
					})
				},
			})
	}
	return jobs, nil
}

// resticCacheDir holds the restic binary for one arch: <cache>/restic/<ver>/<arch>/restic.
// It is mounted over OS/bin in the export.
func resticCacheDir(cache, arch string) string {
	return filepath.Join(cache, "restic", resticVersion, arch)
}

// fetchRestic downloads restic for arch into dir (a no-op when already there),
// checking the pinned sha256 of the archive before unpacking it.
func fetchRestic(ctx context.Context, dir, arch string, logf func(string, ...any)) error {
	want, ok := resticSums[arch]
	if !ok {
		return fmt.Errorf("no restic checksum for %s", arch)
	}
	dest := filepath.Join(dir, "restic")
	if fi, err := os.Stat(dest); err == nil && fi.Mode().IsRegular() && fi.Size() > 0 {
		return nil
	}
	url := fmt.Sprintf("%s/v%s/restic_%s_linux_%s.bz2", resticBase, resticVersion, resticVersion, arch)
	logf("downloading %s", url)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download restic %s: %w", arch, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download restic %s: %s", arch, resp.Status)
	}
	archive, err := os.CreateTemp(dir, ".restic-*.bz2")
	if err != nil {
		return err
	}
	defer os.Remove(archive.Name())
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(archive, h), resp.Body); err != nil {
		archive.Close()
		return fmt.Errorf("download restic %s: %w", arch, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		archive.Close()
		return fmt.Errorf("restic %s archive has sha256 %s, want %s", arch, got, want)
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".restic-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, bzip2.NewReader(bufio.NewReader(archive))); err != nil {
		tmp.Close()
		return fmt.Errorf("unpack restic %s: %w", arch, err)
	}
	if err := tmp.Chmod(0o755); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	archive.Close()
	return os.Rename(tmp.Name(), dest)
}

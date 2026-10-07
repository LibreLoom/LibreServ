package parts

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// connectSite is one Vite app of a Connect web bundle.
type connectSite struct {
	Name   string // job step name
	Dir    string // app dir relative to the unit dir ("web/admin")
	Prefix string // where its files go in the tarball ("admin"; "" = the bundle root)
}

// connectUnit describes how one Connect server is built. The shared deploy
// script (infra/connect-deploy) unpacks the web bundle and requires
// WebRequire to exist at its root.
type connectUnit struct {
	Unit       string
	Dir        string // unit dir in the repo ("sol/connect")
	Main       string // main package ("./cmd/server")
	Sites      []connectSite
	WebRequire []string
}

var connectUnits = []connectUnit{
	{
		Unit: "sol-connect", Dir: "sol/connect", Main: "./cmd/server",
		Sites: []connectSite{
			{Name: "admin", Dir: "web/admin", Prefix: "admin"},
			{Name: "customer", Dir: "web/customer", Prefix: "customer"},
		},
		WebRequire: []string{"admin/index.html", "customer/index.html"},
	},
	{
		Unit: "luna-connect", Dir: "luna/connect", Main: "./cmd/server",
		Sites:      []connectSite{{Name: "site", Dir: "web", Prefix: ""}},
		WebRequire: []string{"index.html"},
	},
}

func init() {
	for _, u := range connectUnits {
		Register(u.Unit, connectServer{u}, connectWeb{u})
	}
}

func (u connectUnit) serverFile() string { return u.Unit + "-server-linux-amd64" }
func (u connectUnit) webFile() string    { return u.Unit + "-web.tar.gz" }

// connectServer builds <unit>-server-linux-amd64: static, version stamped as
// main.version, main.gitCommit and main.buildTime.
type connectServer struct{ u connectUnit }

func (p connectServer) Name() string { return "server" }
func (p connectServer) Unit() string { return p.u.Unit }

func (p connectServer) Artifacts(b *engine.BuildContext) []Artifact {
	return []Artifact{{Unit: p.u.Unit, Part: "server", OS: "linux", Arch: "amd64",
		File: p.u.serverFile(), Path: filepath.Join(b.PartOutDir("server"), p.u.serverFile())}}
}

func (p connectServer) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	st, err := newStamp(b)
	if err != nil {
		return nil, err
	}
	u := p.u
	return []engine.Job{{
		ID:    u.Unit + "/server",
		Title: u.Unit + " server",
		Run: func(ctx context.Context, j *engine.JobRun) error {
			out := b.PartOutDir("server")
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
			file := u.serverFile()
			os.Remove(filepath.Join(out, file))
			workdir := srcPath(u.Dir)
			err := j.Container(ctx, engine.RunSpec{
				Image:     "go",
				Source:    b.SrcDir,
				Out:       out,
				Workdir:   workdir,
				Memory:    buildMemory,
				Caches:    engine.GoCaches(),
				ExtraOpts: goTarget("amd64"),
				Cmd: []string{"go", "build",
					"-ldflags", st.ldflags("main.version", "main.gitCommit", "main.buildTime"),
					"-o", "/out/" + file, u.Main},
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
				Cmd: []string{"sh", "-c", checkStampScript, "sh", "/out/" + file,
					st.Version, st.Commit, st.Time, workdir, u.Main, "version", "gitCommit", "buildTime"},
			})
		},
	}}, nil
}

// connectWeb builds each Vite app, then packs <unit>-web.tar.gz.
type connectWeb struct{ u connectUnit }

func (p connectWeb) Name() string { return "web" }
func (p connectWeb) Unit() string { return p.u.Unit }

func (p connectWeb) Artifacts(b *engine.BuildContext) []Artifact {
	return []Artifact{{Unit: p.u.Unit, Part: "web", OS: "any", Arch: "any",
		File: p.u.webFile(), Path: filepath.Join(b.PartOutDir("web"), p.u.webFile())}}
}

func (p connectWeb) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	u := p.u
	stage := b.PartOutDir("web-build") // intermediate: one dir per site
	var jobs []engine.Job
	var deps []string
	var members []tarMember
	for _, s := range u.Sites {
		s := s
		id := u.Unit + "/web:" + s.Name
		deps = append(deps, id)
		siteOut := filepath.Join(stage, s.Name)
		members = append(members, tarMember{Dir: siteOut, Prefix: s.Prefix})
		jobs = append(jobs, engine.Job{
			ID:    id,
			Title: u.Unit + " web " + s.Name,
			Run: func(ctx context.Context, j *engine.JobRun) error {
				if err := freshDir(siteOut); err != nil {
					return err
				}
				appDir := u.Dir + "/" + s.Dir
				return j.Container(ctx, viteBuild(b, u.Unit+"-"+s.Name, appDir, appDir+"/dist", siteOut, false))
			},
		})
	}
	tarball := filepath.Join(b.PartOutDir("web"), u.webFile())
	jobs = append(jobs, engine.Job{
		ID:    u.Unit + "/web",
		Title: u.Unit + " web bundle",
		Deps:  deps,
		Run: func(ctx context.Context, j *engine.JobRun) error {
			if err := os.MkdirAll(filepath.Dir(tarball), 0o755); err != nil {
				return err
			}
			if err := packTarGz(tarball, members, u.WebRequire); err != nil {
				return err
			}
			j.Logf("packed %s", u.webFile())
			return nil
		},
	})
	return jobs, nil
}

// tarMember is a directory whose files go under Prefix in the tarball.
type tarMember struct{ Dir, Prefix string }

// packTarGz writes a reproducible .tar.gz (sorted, zero times, root owner,
// no leading "./") of the members and fails unless every required path is in it.
func packTarGz(dest string, members []tarMember, require []string) error {
	type entry struct {
		name, src string
		dir       bool
	}
	var entries []entry
	for _, m := range members {
		err := filepath.WalkDir(m.Dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(m.Dir, p)
			if err != nil {
				return err
			}
			name := filepath.ToSlash(rel)
			if rel == "." {
				if m.Prefix == "" {
					return nil
				}
				name = m.Prefix
			} else if m.Prefix != "" {
				name = m.Prefix + "/" + name
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("%s: symlinks are not allowed in a web bundle", p)
			}
			entries = append(entries, entry{name: name, src: p, dir: d.IsDir()})
			return nil
		})
		if err != nil {
			return err
		}
	}
	sort.Slice(entries, func(i, k int) bool { return entries[i].name < entries[k].name })
	have := map[string]bool{}
	for _, e := range entries {
		have[e.name] = true
	}
	for _, r := range require {
		if !have[r] {
			return fmt.Errorf("web bundle is missing %q", r)
		}
	}

	tmp, err := os.CreateTemp(filepath.Dir(dest), ".web-*.tar.gz")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	gz, err := gzip.NewWriterLevel(tmp, gzip.BestCompression)
	if err != nil {
		return err
	}
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if e.dir {
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: e.name + "/", Mode: 0o755, ModTime: time.Unix(0, 0), Format: tar.FormatPAX}); err != nil {
				return err
			}
			continue
		}
		fi, err := os.Stat(e.src)
		if err != nil {
			return err
		}
		mode := int64(0o644)
		if fi.Mode()&0o111 != 0 {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: e.name, Size: fi.Size(), Mode: mode, ModTime: time.Unix(0, 0), Format: tar.FormatPAX}); err != nil {
			return err
		}
		f, err := os.Open(e.src)
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dest)
}

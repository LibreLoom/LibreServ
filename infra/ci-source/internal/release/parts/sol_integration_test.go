package parts

import (
	"bytes"
	"context"
	"debug/elf"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

const itestVersion = "9.9.9-0.dev.1"

func repoRoot(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not in a git checkout: ", err)
	}
	return strings.TrimSpace(string(out))
}

func skipWithoutPodman(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("podman"); err != nil || os.Getenv("LIBRESERV_RELEASE_NO_PODMAN_TESTS") != "" {
		t.Skip("podman not available")
	}
	if err := exec.Command("podman", "info").Run(); err != nil {
		t.Skip("podman not usable: ", err)
	}
}

func fileList(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// Builds sol (amd64 only, to keep it quick; set LIBRESERV_PARTS_ARM64=1 for
// both arches), sol-connect and luna-connect for real into a temp out dir, then checks
// names, layout and stamped versions. The source export and the container
// caches are the tool's own, so repeated runs are warm.
func TestBuildSolAndConnect(t *testing.T) {
	skipWithoutPodman(t)
	repo := repoRoot(t)
	eng, err := engine.New(engine.Config{Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	srcDir, sha, err := eng.Export(ctx, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	before := fileList(t, srcDir)

	outRoot := t.TempDir()
	var all []engine.Part
	var arts []Artifact
	graph := engine.NewGraph()
	for _, unit := range []string{"sol", "sol-connect", "luna-connect"} {
		b := &engine.BuildContext{Engine: eng, Unit: unit, Version: itestVersion, Commit: sha, SrcDir: srcDir, OutRoot: outRoot}
		g, err := engine.BuildGraph(b, For(unit))
		if err != nil {
			t.Fatal(err)
		}
		for _, j := range g.Jobs() {
			if os.Getenv("LIBRESERV_PARTS_ARM64") == "" && strings.HasSuffix(j.ID, "arm64") {
				continue
			}
			if err := graph.Add(j); err != nil {
				t.Fatal(err)
			}
		}
		all = append(all, For(unit)...)
		arts = append(arts, Artifacts(b, For(unit))...)
	}
	if err := graph.Validate(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = all })

	res, err := graph.Run(ctx, engine.Options{
		Jobs: 3, Engine: eng,
		OnEvent: func(ev engine.Event) {
			switch ev.Type {
			case engine.EventLog:
				t.Logf("[%s] %s", ev.Job, ev.Line)
			case engine.EventFinished:
				t.Logf("%s: %s in %s", ev.Job, ev.Status, ev.Elapsed.Round(time.Second))
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK() {
		t.Fatal(res.FirstError())
	}
	t.Logf("graph took %s", res.Duration.Round(time.Second))

	want := map[string]bool{
		"libreserv-linux-amd64": true, "sol-connect-server-linux-amd64": true, "sol-connect-web.tar.gz": true,
		"luna-connect-server-linux-amd64": true, "luna-connect-web.tar.gz": true,
	}
	for _, a := range arts {
		if os.Getenv("LIBRESERV_PARTS_ARM64") == "" && a.Arch == "arm64" {
			continue
		}
		if !want[a.File] && a.File != "libreserv-linux-arm64" {
			t.Errorf("unexpected artifact %s", a.File)
		}
		delete(want, a.File)
		fi, err := os.Stat(a.Path)
		if err != nil || fi.Size() == 0 {
			t.Errorf("%s: %v", a.Path, err)
			continue
		}
		if strings.Contains(a.File, "linux") {
			checkStaticELF(t, a.Path, a.Arch)
			body, _ := os.ReadFile(a.Path)
			if !bytes.Contains(body, []byte(itestVersion)) {
				t.Errorf("%s does not contain version %s", a.File, itestVersion)
			}
		}
		if a.File == "libreserv-linux-amd64" && !bytes.Contains(mustRead(t, a.Path), []byte("restic")) {
			t.Error("sol binary has no embedded restic")
		}
		if strings.HasSuffix(a.File, ".tar.gz") {
			checkWithDeployScript(t, repo, a)
			got := readTar(t, a.Path)
			required := []string{"admin/index.html", "customer/index.html"}
			if a.Unit == "luna-connect" {
				required = []string{"index.html"}
			}
			for _, r := range required {
				if got[r] == "" {
					t.Errorf("web bundle lacks %s", r)
				}
			}
		}
	}
	for f := range want {
		t.Errorf("artifact %s not listed", f)
	}

	after := fileList(t, srcDir)
	if strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Errorf("build wrote files into the source export:\n before %d files, after %d files", len(before), len(after))
	}
}

func mustRead(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func checkStaticELF(t *testing.T, path, arch string) {
	t.Helper()
	f, err := elf.Open(path)
	if err != nil {
		t.Errorf("%s: %v", path, err)
		return
	}
	defer f.Close()
	wantMachine := map[string]elf.Machine{"amd64": elf.EM_X86_64, "arm64": elf.EM_AARCH64}[arch]
	if f.Machine != wantMachine {
		t.Errorf("%s: machine %v, want %v", path, f.Machine, wantMachine)
	}
	if libs, _ := f.ImportedLibraries(); len(libs) > 0 {
		t.Errorf("%s is not static: needs %v", path, libs)
	}
	if f.Section(".interp") != nil {
		t.Errorf("%s has an interpreter (dynamic)", path)
	}
}

// checkWithDeployScript unpacks the web bundle with the real unpack_web of
// infra/connect-deploy/deploy.sh, which refuses bundles missing the entries
// the unit requires.
func checkWithDeployScript(t *testing.T, repo string, a Artifact) {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "web")
	cmd := exec.Command("bash", "-c", `source "$1"; load_unit "$2"; unpack_web "$3" "$4"`,
		"bash", filepath.Join(repo, "infra", "connect-deploy", "deploy.sh"), a.Unit, a.Path, dest)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Errorf("deploy.sh rejects %s: %v\n%s", a.File, err, out)
	}
}

// Builds lunad twice from the same export with different versions, in the
// persistent cargo volume: the second binary must report the second version
// (the lunad smoke job fails otherwise). Needs podman; reuses the tool's own
// caches, and rebuilds lunad twice.
func TestLunadVersionChangeRebuilds(t *testing.T) {
	skipWithoutPodman(t)
	if os.Getenv("LIBRESERV_RELEASE_SLOW_TESTS") == "" {
		t.Skip("slow: set LIBRESERV_RELEASE_SLOW_TESTS=1")
	}
	repo := repoRoot(t)
	eng, err := engine.New(engine.Config{Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Minute)
	defer cancel()
	srcDir, sha, err := eng.Export(ctx, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"9.9.9-0.dev.1", "9.9.9-0.dev.2"} {
		b := &engine.BuildContext{Engine: eng, Unit: "luna", Version: v, Commit: sha, SrcDir: srcDir, OutRoot: t.TempDir(), Only: []string{"lunad"}}
		g, err := engine.BuildGraph(b, For("luna"))
		if err != nil {
			t.Fatal(err)
		}
		res, err := g.Run(ctx, engine.Options{Jobs: 2, Engine: eng})
		if err != nil {
			t.Fatal(err)
		}
		if !res.OK() {
			t.Fatalf("version %s: %v", v, res.FirstError())
		}
		body, _ := os.ReadFile(filepath.Join(b.PartOutDir("lunad"), LunadFile))
		if !bytes.Contains(body, []byte(v)) {
			t.Errorf("lunad built for %s does not contain it", v)
		}
	}
}

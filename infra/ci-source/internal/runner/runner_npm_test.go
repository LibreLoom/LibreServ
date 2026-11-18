package runner

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

func TestIsNpmTestMatchesNonNodeImages(t *testing.T) {
	e2e := &tests.Test{Container: "mcr.microsoft.com/playwright:v1.64.1-noble", Command: "npm run test:e2e:recovery"}
	if !isNpmTest(e2e) {
		t.Fatal("the Playwright e2e test runs npm but said it does not")
	}
	unit := &tests.Test{Container: "node:26-alpine", Command: "npm test -- --run"}
	if !isNpmTest(unit) {
		t.Fatal("a node-image npm test said it does not run npm")
	}
	goTest := &tests.Test{Container: "golang:1.27-alpine", Command: "go test ./..."}
	if isNpmTest(goTest) {
		t.Fatal("a go test said it runs npm")
	}
}

func TestWarmNodeTasksIncludesLinkedUIForEachRuntime(t *testing.T) {
	repo := t.TempDir()
	for _, workDir := range []string{"/repo/luna/web", "/repo/shared/ui"} {
		dir := hostWorkDir(repo, workDir)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	r := Runner{repoPath: repo}
	node := &tests.Test{
		Container: "node:26-alpine", Command: "npm test", WorkDir: "/repo/luna/web",
	}
	browser := &tests.Test{
		Container: "mcr.microsoft.com/playwright:v1.64.1-noble", Command: "npm test", WorkDir: "/repo/luna/web",
	}
	shared := &tests.Test{
		Container: node.Container, Command: "npm test", WorkDir: "/repo/shared/ui",
	}
	var got []string
	for _, task := range r.warmNodeTasks([]*tests.Test{node, browser, shared}) {
		got = append(got, task.ID)
	}
	want := []string{
		"_warm-npm-luna-web", "_warm-npm-shared-ui",
		"_warm-npm-luna-web-glibc", "_warm-npm-shared-ui-glibc",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("warm tasks = %v, want %v", got, want)
	}
}

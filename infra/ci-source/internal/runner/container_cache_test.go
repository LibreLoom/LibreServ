package runner

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestContainerCacheRoot(t *testing.T) {
	repo := t.TempDir()
	if got, err := containerCacheRoot(repo, ""); err != nil || got != filepath.Join(repo, ".cache") {
		t.Fatalf("default cache = %q, %v", got, err)
	}
	owned := t.TempDir()
	if got, err := containerCacheRoot(repo, owned); err != nil || got != owned {
		t.Fatalf("override = %q, %v", got, err)
	}
	link := filepath.Join(repo, "link")
	if err := os.Symlink(owned, link); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"relative", owned + "/../" + filepath.Base(owned), owned + ":other", link, filepath.Join(repo, "missing")} {
		if got, err := containerCacheRoot(repo, invalid); err == nil {
			t.Errorf("accepted %q as %q", invalid, got)
		}
	}
	if err := os.Chmod(owned, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := containerCacheRoot(repo, owned); err == nil {
		t.Fatal("accepted writable cache directory")
	}
}

func TestLaunchErrorClassDoesNotExposeDetails(t *testing.T) {
	if got := launchErrorClass(errors.New("permission denied for secret-token")); got != "permission denied" {
		t.Fatal(got)
	}
	if got := launchErrorClass(errors.New("secret-token")); got != "runtime error (details withheld)" {
		t.Fatal(got)
	}
}

func TestContainerCacheBindsKeepLifelineIndependent(t *testing.T) {
	for _, cache := range []string{"/repo/.cache", "/tmp/owned-cache"} {
		want := []string{"/repo:/repo:z", cache + ":/cache:z"}
		if got := containerBaseBinds("/repo", cache); !reflect.DeepEqual(got, want) {
			t.Fatalf("cache %s: binds %v", cache, got)
		}
		if got := containerCommand("true", 0, ".ci-run-7.lock"); got[4] != "/repo/.cache/.ci-run-7.lock" {
			t.Fatalf("lifeline path = %q", got[4])
		}
	}
}

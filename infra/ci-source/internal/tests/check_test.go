package tests

import (
	"strings"
	"testing"
)

// `ci check -changed` decides what to run from the diff. Under-selecting ships
// a broken change, so these tests pin the two invariants that matter: a known
// path selects the right tests, and an unknown path selects everything.

func TestCheckIDsExcludeSlowChecksByDefault(t *testing.T) {
	fast := CheckIDs(true)
	all := CheckIDs(false)

	if len(all) <= len(fast) {
		t.Fatalf("slow checks did not widen the set: fast=%d all=%d", len(fast), len(all))
	}
	for _, id := range fast {
		if IsSlowCheck(id) {
			t.Errorf("fast check set contains slow check %q", id)
		}
	}
}

func TestCheckIDsExistInRegistry(t *testing.T) {
	for _, id := range CheckIDs(false) {
		if len(DefaultRegistry.GetByIDs([]string{id})) == 0 {
			t.Errorf("check %q is not in the registry", id)
		}
	}
}

func TestEveryCheckIDIsClassified(t *testing.T) {
	// A test whose ID looks like a check but is not classified would silently
	// be skipped by `ci check` — the exact failure this guards against.
	suspicious := []string{"-fmt", "-vet", "-lint", "-typecheck", "-colors"}
	for _, test := range DefaultRegistry.List() {
		for _, suffix := range suspicious {
			if strings.HasSuffix(test.ID, suffix) && !IsCheck(test.ID) {
				t.Errorf("test %q looks like a check but is not classified as one", test.ID)
			}
		}
	}
}

func TestTestsForPathsSelectsByWorkDir(t *testing.T) {
	got := TestsForPaths([]string{"sol/server/backend/internal/config/config.go"})
	ids := idSet(got)

	if !ids["go-vet"] || !ids["go-test"] {
		t.Error("a backend path did not select the backend Go tests")
	}
	if ids["frontend-lint"] {
		t.Error("a backend path selected a frontend test")
	}
}

func TestTestsForPathsWidensForSharedUI(t *testing.T) {
	got := TestsForPaths([]string{"shared/ui/components/ui/Tooltip.jsx"})
	ids := idSet(got)

	// Both webs depend on shared/ui, so both must be selected.
	if !ids["frontend-lint"] {
		t.Error("shared/ui change did not select the Sol frontend")
	}
	if !ids["luna-web-colors"] {
		t.Error("shared/ui change did not select the Luna web")
	}
}

func TestTestsForPathsSelectsEverythingWhenNothingMatches(t *testing.T) {
	// A path outside every WorkDir means the mapping does not understand the
	// change. Widening is the only safe answer.
	got := TestsForPaths([]string{"docs/some-new-dir/notes.md"})
	if len(got) != len(DefaultRegistry.List()) {
		t.Fatalf("unknown path selected %d tests, want all %d", len(got), len(DefaultRegistry.List()))
	}
}

func TestTestsForPathsEmptySelectsEverything(t *testing.T) {
	got := TestsForPaths(nil)
	if len(got) != len(DefaultRegistry.List()) {
		t.Fatalf("empty path set selected %d tests, want all %d", len(got), len(DefaultRegistry.List()))
	}
}

func TestTestsForPathsAlwaysIncludesRepoWideTests(t *testing.T) {
	got := TestsForPaths([]string{"sol/server/backend/internal/config/config.go"})
	ids := idSet(got)
	if !ids["luna-ci"] {
		t.Error("a repo-wide test (luna-ci) was dropped for a narrow change")
	}
}

func TestFilterChecksKeepsOnlyChecks(t *testing.T) {
	got := FilterChecks(DefaultRegistry.List(), true)
	if len(got) == 0 {
		t.Fatal("no checks selected")
	}
	for _, test := range got {
		if !IsCheck(test.ID) {
			t.Errorf("%q is not a check", test.ID)
		}
	}
}

func TestNormalizePathsStripsRepoRoot(t *testing.T) {
	got := NormalizePaths("/repo", []string{
		"/repo/sol/server/backend/x.go",
		"./luna/web/y.jsx",
		"  infra/ci-source/z.go  ",
		"",
	})
	want := []string{"infra/ci-source/z.go", "luna/web/y.jsx", "sol/server/backend/x.go"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func idSet(list []*Test) map[string]bool {
	ids := make(map[string]bool, len(list))
	for _, t := range list {
		ids[t.ID] = true
	}
	return ids
}

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCIGateRunsProfilesUnlimitedAndReportsFailure(t *testing.T) {
	repo := t.TempDir()
	script := "#!/bin/sh\necho \"args: $*\"\n[ \"$3\" = bad ] && { echo '✗ Broken (1s)'; exit 1; }\nexit 0\n"
	if err := os.WriteFile(filepath.Join(repo, "ci"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	log := func(l string) { lines = append(lines, l) }

	if err := ciGate(repo)(t.Context(), []string{"cut-sol", "cut-luna"}, log); err != nil {
		t.Fatal(err)
	}
	all := strings.Join(lines, "\n")
	if !strings.Contains(all, "args: run --profile cut-sol --session") || !strings.Contains(all, "args: run --profile cut-luna --session") {
		t.Fatalf("ci must run each profile with -session, got:\n%s", all)
	}

	lines = nil
	err := ciGate(repo)(t.Context(), []string{"bad", "cut-luna"}, log)
	if err == nil || !strings.Contains(err.Error(), `profile "bad"`) {
		t.Fatalf("want failure naming the profile, got %v", err)
	}
	if strings.Contains(strings.Join(lines, "\n"), "--profile cut-luna") {
		t.Fatal("a failed profile must stop the gate")
	}
	if !strings.Contains(strings.Join(lines, "\n"), "Broken") {
		t.Fatal("failure output must reach the log")
	}
}

package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func commitAs(t *testing.T, w *world, author, file, subject string) {
	t.Helper()
	p := filepath.Join(w.repo, file)
	must(t, os.MkdirAll(filepath.Dir(p), 0o755))
	must(t, os.WriteFile(p, []byte(subject+fmt.Sprint(len(subject))+"\n"), 0o644))
	git(t, w.repo, "add", file)
	git(t, w.repo, "-c", "user.name="+author, "commit", "-q", "--author", author+" <b@example.invalid>", "-m", subject)
}

func TestDraftNotesFiltersBotsPathsAndLength(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	commitAs(t, w, "Test", "luna/a.txt", "feat(luna): old work")
	git(t, w.repo, "tag", "luna-v0.0.39") // an old-style tag: where notes start from
	commitAs(t, w, "Test", "luna/b.txt", "feat(luna): faster uploads")
	commitAs(t, w, "docs-bot", "luna/c.txt", "docs: regenerate")
	commitAs(t, w, "lock-bot", "luna/d.txt", "chore(deps): lock")
	commitAs(t, w, "atlas-bot", "luna/e.txt", "chore: atlas")
	commitAs(t, w, "Test", "sol/x.txt", "feat(sol): not luna")
	d, err := w.app.NotesDraft(ctx, "luna")
	must(t, err)
	if d.Text != "- feat(luna): faster uploads\n" {
		t.Fatalf("draft = %q", d.Text)
	}
	if !d.FirstRelease || d.Since != "luna-v0.0.39" || !strings.Contains(d.Hint(), "luna-v0.0.39") {
		t.Fatalf("legacy base: %+v", d)
	}

	// No tag at all: cap the length and say it is only a start.
	git(t, w.repo, "tag", "-d", "luna-v0.0.39")
	for i := 0; i < 40; i++ {
		commitAs(t, w, "Test", fmt.Sprintf("luna/many%d.txt", i), fmt.Sprintf("fix(luna): change %d", i))
	}
	d, err = w.app.NotesDraft(ctx, "luna")
	must(t, err)
	if n := strings.Count(d.Text, "\n"); n > maxDraftLines+1 || d.Omitted == 0 || !strings.Contains(d.Text, "more changes") {
		t.Fatalf("not capped: %d lines, omitted %d", n, d.Omitted)
	}
	if !d.FirstRelease || d.Since != "" || !strings.Contains(d.Hint(), "Write the real notes") {
		t.Fatalf("hint: %+v", d)
	}

	// A tag made by this tool is a normal base.
	git(t, w.repo, "tag", "luna/v0.1.0")
	commitAs(t, w, "Test", "luna/after.txt", "fix(luna): after the tag")
	d, err = w.app.NotesDraft(ctx, "luna")
	must(t, err)
	if d.FirstRelease || d.Hint() != "" || d.Text != "- fix(luna): after the tag\n" {
		t.Fatalf("new-style tag: %+v", d)
	}
}

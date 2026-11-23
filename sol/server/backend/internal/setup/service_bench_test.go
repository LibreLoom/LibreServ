package setup

import (
	"context"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/Sol/internal/database"
)

func benchCompleteService(b *testing.B) *Service {
	b.Helper()
	db, err := database.Open(filepath.Join(b.TempDir(), "bench.db"))
	if err != nil {
		b.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = db.Close() })
	svc := NewService(db)
	ctx := context.Background()
	if _, err := svc.Ensure(ctx); err != nil {
		b.Fatal(err)
	}
	if _, err := svc.MarkComplete(ctx); err != nil {
		b.Fatal(err)
	}
	return svc
}

// IsComplete runs on every authenticated request. It used to read and decode
// the whole setup_state row under the service mutex; the cached path is a
// couple of atomic loads.
func BenchmarkIsCompleteCached(b *testing.B) {
	svc := benchCompleteService(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if !svc.IsComplete(ctx) {
			b.Fatal("expected complete")
		}
	}
}

func BenchmarkIsCompleteUncached(b *testing.B) {
	svc := benchCompleteService(b)
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		svc.InvalidateCompletion()
		if !svc.IsComplete(ctx) {
			b.Fatal("expected complete")
		}
	}
}

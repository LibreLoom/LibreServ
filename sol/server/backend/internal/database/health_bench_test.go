package database

import (
	"fmt"
	"path/filepath"
	"testing"
)

// A modest table makes the integrity scan do real work: the point of these
// benchmarks is that a health probe must not pay for a full database walk.
func benchDB(b *testing.B) *DB {
	b.Helper()
	db, err := Open(filepath.Join(b.TempDir(), "bench.db"))
	if err != nil {
		b.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 5000; i++ {
		if _, err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'hash')`,
			fmt.Sprintf("bench-%d", i), fmt.Sprintf("user-%d", i)); err != nil {
			b.Fatal(err)
		}
	}
	b.Cleanup(func() { _ = db.Close() })
	return db
}

func BenchmarkHealthCheck(b *testing.B) {
	db := benchDB(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := db.HealthCheck(); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkIntegrityCheck(b *testing.B) {
	db := benchDB(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := db.IntegrityCheck(); err != nil {
			b.Fatal(err)
		}
	}
}

package network

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestCaddyManagerReloadAdminAPIRetriesThenSucceeds(t *testing.T) {
	t.Parallel()

	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/load" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		calls++
		if calls <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("temporarily unavailable"))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	tmp, err := os.CreateTemp("", "caddyfile-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(tmp.Name()) })
	if err := os.WriteFile(tmp.Name(), []byte("example.com { respond \"ok\" }"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Use an in-memory-ish sqlite path (temp) since CaddyManager wants a DB,
	// but reloadCaddy itself doesn't touch the DB.
	dbFile, err := os.CreateTemp("", "libreserv-test-*.db")
	if err != nil {
		t.Fatal(err)
	}
	_ = dbFile.Close()
	t.Cleanup(func() { _ = os.Remove(dbFile.Name()) })
	db, err := database.Open(dbFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cm := NewCaddyManager(db, CaddyConfig{
		Mode:       "enabled",
		AdminAPI:   srv.URL,
		ConfigPath: tmp.Name(),
		Reload: CaddyReloadConfig{
			Retries:        3,
			BackoffMin:     1 * time.Millisecond,
			BackoffMax:     2 * time.Millisecond,
			JitterFraction: 0,
			AttemptTimeout: 500 * time.Millisecond,
		},
	})

	if err := cm.reloadCaddy(); err != nil {
		t.Fatalf("reloadCaddy() error = %v", err)
	}
	if calls != 3 {
		t.Fatalf("expected 3 /load calls, got %d", calls)
	}
}

func TestCaddyManagerReloadNoopModeNoError(t *testing.T) {
	t.Parallel()

	dbFile, err := os.CreateTemp("", "libreserv-test-*.db")
	if err != nil {
		t.Fatal(err)
	}
	_ = dbFile.Close()
	t.Cleanup(func() { _ = os.Remove(dbFile.Name()) })
	db, err := database.Open(dbFile.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cm := NewCaddyManager(db, CaddyConfig{Mode: "noop"})
	if err := cm.reloadCaddy(); err != nil {
		t.Fatalf("noop reloadCaddy() error = %v", err)
	}
}

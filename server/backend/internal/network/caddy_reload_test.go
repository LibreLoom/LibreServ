package network

import (
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestCaddyManagerReloadAdminAPIRetriesThenSucceeds(t *testing.T) {
	t.Parallel()

	rt := &recordingRoundTripper{}
	client := &http.Client{Transport: rt}

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
		AdminAPI:   "http://caddy.test",
		ConfigPath: tmp.Name(),
		Reload: CaddyReloadConfig{
			Retries:        3,
			BackoffMin:     1 * time.Millisecond,
			BackoffMax:     2 * time.Millisecond,
			JitterFraction: 0,
			AttemptTimeout: 500 * time.Millisecond,
		},
	})
	cm.httpClient = client

	if err := cm.reloadCaddy(); err != nil {
		t.Fatalf("reloadCaddy() error = %v", err)
	}
	if rt.calls != 3 {
		t.Fatalf("expected 3 /load calls, got %d", rt.calls)
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

type recordingRoundTripper struct {
	calls int
}

// RoundTrip emulates Caddy admin /load behavior: two failures then success.
func (rt *recordingRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.calls++

	status := http.StatusOK
	body := ""
	if req.URL.Path != "/load" {
		status = http.StatusNotFound
	} else if rt.calls <= 2 {
		status = http.StatusServiceUnavailable
		body = "temporarily unavailable"
	}

	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}, nil
}

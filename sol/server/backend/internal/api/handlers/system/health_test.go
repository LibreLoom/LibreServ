package system

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/Sol/internal/database"
)

func TestHealthEndpoints(t *testing.T) {
	db, _ := database.Open(":memory:")
	_ = db.Migrate()

	h := NewHealthHandler(db)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	h.HealthCheck(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("health expected 200, got %d", rr.Code)
	}

	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	h.ReadinessCheck(rr2, req2)
	if rr2.Code != http.StatusOK {
		t.Fatalf("ready expected 200, got %d", rr2.Code)
	}
}

func TestLivenessCheck(t *testing.T) {
	db, _ := database.Open(":memory:")
	_ = db.Migrate()

	h := NewHealthHandler(db)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	h.LivenessCheck(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("liveness expected 200, got %d", rr.Code)
	}
}

func TestVersion(t *testing.T) {
	db, _ := database.Open(":memory:")
	_ = db.Migrate()

	h := NewHealthHandler(db)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	h.Version(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("version expected 200, got %d", rr.Code)
	}
}

func TestDatabaseIntegrityEndpoint(t *testing.T) {
	db, err := database.Open(t.TempDir() + "/health.db")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	h := NewHealthHandler(db)

	start := httptest.NewRecorder()
	h.DatabaseIntegrity(start, httptest.NewRequest(http.MethodPost, "/api/v1/system/database/integrity", nil))
	if start.Code != http.StatusAccepted {
		t.Fatalf("start expected 202, got %d: %s", start.Code, start.Body.String())
	}

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		rr := httptest.NewRecorder()
		h.DatabaseIntegrityStatus(rr, httptest.NewRequest(http.MethodGet, "/api/v1/system/database/integrity/status", nil))
		if !strings.Contains(rr.Body.String(), `"status":"running"`) {
			if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"status":"ok"`) {
				t.Fatalf("integrity expected ok, got %d: %s", rr.Code, rr.Body.String())
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("integrity check did not finish")
}

func TestDatabaseIntegrityMissingFileMessage(t *testing.T) {
	path := t.TempDir() + "/gone.db"
	db, err := database.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	h := NewHealthHandler(db)
	h.DatabaseIntegrity(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/system/database/integrity", nil))

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		rr := httptest.NewRecorder()
		h.DatabaseIntegrityStatus(rr, httptest.NewRequest(http.MethodGet, "/api/v1/system/database/integrity/status", nil))
		body := rr.Body.String()
		if strings.Contains(body, `"status":"running"`) {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		if !strings.Contains(body, "database file is missing") || !strings.Contains(body, "Settings → Backups") {
			t.Fatalf("missing file should name the problem and next step, got: %s", body)
		}
		return
	}
	t.Fatal("integrity check did not finish")
}

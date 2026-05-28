package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
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

package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func activateDevice(t *testing.T, db *sql.DB, token string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}
	// Query to get the device ID from the created record
	var deviceID string
	err := db.QueryRow("SELECT id FROM devices WHERE token_hash = ?", hashToken(token)).Scan(&deviceID)
	if err != nil {
		t.Fatalf("find activated device: %v", err)
	}
	return deviceID
}

func TestDeviceActivate(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	body, _ := json.Marshal(map[string]string{"token": "free_test_token_123"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Activate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("activate status=%d, want 200", w.Code)
	}

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp["connected"].(bool) {
		t.Fatal("expected connected=true")
	}
	plan := resp["plan"].(map[string]any)
	if plan["id"] != "free" {
		t.Fatalf("plan=%v, want free", plan["id"])
	}
}

func TestDeviceActivateMissingToken(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Activate(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d, want 400", w.Code)
	}
}

func TestDeviceStatus(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	deviceID := activateDevice(t, db, "status_test_token")
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/status", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Status(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp["connected"].(bool) {
		t.Fatal("expected connected=true")
	}
}

func TestDeviceDeactivate(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	deviceID := activateDevice(t, db, "deactivate_test_token")
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deactivate", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Deactivate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}

	// Verify device is inactive
	var active bool
	err := db.QueryRow("SELECT is_active FROM devices WHERE id = ?", deviceID).Scan(&active)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if active {
		t.Fatal("expected device to be inactive after deactivation")
	}
}

func TestDeviceUsage(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	deviceID := activateDevice(t, db, "usage_test_token")
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/usage", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Usage(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["total_cost_usd"] == nil {
		t.Fatal("missing total_cost_usd")
	}
}

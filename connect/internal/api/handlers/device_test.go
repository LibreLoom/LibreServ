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
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// activateDevice creates a Connect key and activates a device with it.
// Returns the device ID.
func activateDevice(t *testing.T, db *sql.DB, planID string) string {
	t.Helper()
	if planID == "" {
		planID = "free"
	}

	// Create an account (connect_keys.account_id is NOT NULL).
	accountID := "acc-fix-" + security.RandomString(8)
	_, err := db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', $3)`,
		accountID, accountID+"@test.com", planID)
	if err != nil {
		t.Fatalf("create account: %v", err)
	}

	// Create a Connect key
	key := security.GenerateConnectKey()
	keyHash := hashToken(key)
	connectKeyID := security.GenerateID("lic")
	_, err = db.Exec(
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, status) VALUES ($1, $2, $3, $4, $5, 'unused')`,
		connectKeyID, keyHash, key[:8], accountID, planID)
	if err != nil {
		t.Fatalf("create Connect key: %v", err)
	}

	// Activate device with the Connect key
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	// Query to get the device ID
	var deviceID string
	err = db.QueryRow("SELECT id FROM devices WHERE connect_key_id = $1", connectKeyID).Scan(&deviceID)
	if err != nil {
		t.Fatalf("find activated device: %v", err)
	}
	return deviceID
}

// activateDeviceWithKey activates a device with a specific Connect key and returns both.
func activateDeviceWithKey(t *testing.T, db *sql.DB, planID string) (string, string) {
	t.Helper()
	if planID == "" {
		planID = "free"
	}

	accountID := "acc-fix-" + security.RandomString(8)
	_, err := db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', $3)`,
		accountID, accountID+"@test.com", planID)
	if err != nil {
		t.Fatalf("create account: %v", err)
	}

	key := security.GenerateConnectKey()
	keyHash := hashToken(key)
	connectKeyID := security.GenerateID("lic")
	_, err = db.Exec(
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, status) VALUES ($1, $2, $3, $4, $5, 'unused')`,
		connectKeyID, keyHash, key[:8], accountID, planID)
	if err != nil {
		t.Fatalf("create Connect key: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	var deviceID string
	err = db.QueryRow("SELECT id FROM devices WHERE connect_key_id = $1", connectKeyID).Scan(&deviceID)
	if err != nil {
		t.Fatalf("find activated device: %v", err)
	}
	return deviceID, key
}

func TestDeviceActivate(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewDeviceHandler(db)

	deviceID := activateDevice(t, db, "free")

	var planID string
	err := db.QueryRow("SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID)
	if err != nil {
		t.Fatalf("query device: %v", err)
	}
	if planID != "free" {
		t.Fatalf("plan=%s, want free", planID)
	}
	_ = h // keep compiler happy
}

func TestDeviceActivateMissingKey(t *testing.T) {
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

	deviceID := activateDevice(t, db, "free")
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

	deviceID := activateDevice(t, db, "free")
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/deactivate", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Deactivate(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}

	var active bool
	err := db.QueryRow("SELECT is_active FROM devices WHERE id = $1", deviceID).Scan(&active)
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

	deviceID := activateDevice(t, db, "free")
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

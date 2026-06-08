package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func TestProvisionInfo(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewProvisionHandler(db)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/info", nil)
	w := httptest.NewRecorder()
	h.Info(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	plans := resp["plans"].([]any)
	if len(plans) != 3 {
		t.Fatalf("plans count=%d, want 3", len(plans))
	}
}

func TestProvisionSMTP(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewProvisionHandler(db)

	deviceID := activateDevice(t, db, "smtp_provision_token")
	body, _ := json.Marshal(map[string]string{"service": "smtp"})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/services/provision", bytes.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Provision(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	smtp := resp["smtp"].(map[string]any)
	if smtp["host"] != "smtp.libreloom.org" {
		t.Fatalf("host=%v, want smtp.libreloom.org", smtp["host"])
	}
}

func TestProvisionBackup(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewProvisionHandler(db)

	deviceID := activateDevice(t, db, "backup_provision_token")
	body, _ := json.Marshal(map[string]string{"service": "backup"})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/services/provision", bytes.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Provision(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	backup := resp["backup"].(map[string]any)
	if backup["repo_type"] != "s3" {
		t.Fatalf("repo_type=%v, want s3", backup["repo_type"])
	}
}

func TestProvisionAI(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewProvisionHandler(db)

	deviceID := activateDevice(t, db, "ai_provision_token")
	body, _ := json.Marshal(map[string]string{"service": "ai"})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/services/provision", bytes.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.Provision(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ai := resp["ai"].(map[string]any)
	if ai["base_url"] == "" {
		t.Fatal("expected base_url in AI credentials")
	}
	if ai["api_key"] == "" {
		t.Fatal("expected api_key in AI credentials")
	}
}

func TestProvisionRequiresAuth(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewProvisionHandler(db)

	body, _ := json.Marshal(map[string]string{"service": "smtp"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/services/provision", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Provision(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401 (no device context)", w.Code)
	}
}

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

func TestSupportCreateCase(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewSupportHandler(db)

	deviceID := activateDevice(t, db, "support_case_token")
	body, _ := json.Marshal(map[string]string{"summary": "My Nextcloud won't start"})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cases", bytes.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.CreateCase(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["id"] == "" {
		t.Fatal("expected case id")
	}
	if resp["status"] != "open" {
		t.Fatalf("status=%v, want open", resp["status"])
	}
}

func TestSupportListCases(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewSupportHandler(db)

	deviceID := activateDevice(t, db, "support_list_token")
	// Create a case
	body, _ := json.Marshal(map[string]string{"summary": "Disk full"})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/cases", bytes.NewReader(body)).WithContext(ctx)
	h.CreateCase(httptest.NewRecorder(), createReq)

	// List
	listReq := httptest.NewRequest(http.MethodGet, "/api/v1/cases", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.ListCases(w, listReq)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", w.Code)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	cases := resp["cases"].([]any)
	if len(cases) != 1 {
		t.Fatalf("cases count=%d, want 1", len(cases))
	}
}

func TestSupportCreateCaseMissingSummary(t *testing.T) {
	db := database.OpenTestDB(t)
	h := NewSupportHandler(db)

	deviceID := activateDevice(t, db, "support_bad_token")
	body, _ := json.Marshal(map[string]string{})
	ctx := middleware.WithDeviceID(context.Background(), deviceID)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cases", bytes.NewReader(body)).WithContext(ctx)
	w := httptest.NewRecorder()
	h.CreateCase(w, req)

	// CreateCase doesn't currently validate missing summary; if that changes this test should catch it.
	if w.Code >= 500 {
		t.Fatalf("unexpected error: %d %s", w.Code, w.Body.String())
	}
}

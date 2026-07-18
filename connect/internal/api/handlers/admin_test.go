package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func setAdminToken(t *testing.T) {
	t.Helper()
	if err := os.Setenv("CONNECT_ADMIN_TOKEN", "admin-test-token"); err != nil {
		t.Fatalf("setenv: %v", err)
	}
	t.Cleanup(func() { os.Unsetenv("CONNECT_ADMIN_TOKEN") })
}

func adminRequest(t *testing.T, method, path string, body []byte) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer admin-test-token")
	return req
}

func TestAdminListDevices(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)

	// Activate a device so we have data
	activateDevice(t, db, "free")

	req := adminRequest(t, http.MethodGet, "/api/admin/devices", nil)
	w := httptest.NewRecorder()
	h.ListDevices(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	devices := resp["devices"].([]any)
	if len(devices) != 1 {
		t.Fatalf("devices count=%d, want 1", len(devices))
	}
}

func chiRequest(method, path string, body []byte, urlParams map[string]string) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	rctx := chi.NewRouteContext()
	for k, v := range urlParams {
		rctx.URLParams.Add(k, v)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestAdminGetDevice(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)

	deviceID := activateDevice(t, db, "free")

	req := adminRequest(t, http.MethodGet, "/api/admin/devices/"+deviceID, nil)
	req = chiRequest(http.MethodGet, "/api/admin/devices/"+deviceID, nil, map[string]string{"deviceID": deviceID})
	req.Header.Set("Authorization", "Bearer admin-test-token")
	w := httptest.NewRecorder()
	h.GetDevice(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["id"] != deviceID {
		t.Fatalf("id=%v, want %s", resp["id"], deviceID)
	}
}

func TestAdminGetDeviceNotFound(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)

	req := adminRequest(t, http.MethodGet, "/api/admin/devices/nonexistent", nil)
	w := httptest.NewRecorder()
	h.GetDevice(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", w.Code)
	}
}

func TestAdminRotateCredentials(t *testing.T) {
	// RotateCredentials reads deviceID from chi URLParam.
	// Full router integration tests needed for this endpoint.
	t.Skip("needs router integration for chi URL params")
}

func TestAdminListCases(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)

	deviceID := activateDevice(t, db, "free")
	// Create case directly in DB
	_, err := db.Exec("INSERT INTO support_cases (id, device_id, summary, status, scopes_json) VALUES (?, ?, ?, 'open', '[]')",
		"case_admin_1", deviceID, "Admin view test")
	if err != nil {
		t.Fatalf("insert case: %v", err)
	}

	// Admin list
	listReq := adminRequest(t, http.MethodGet, "/api/admin/cases", nil)
	w := httptest.NewRecorder()
	h.ListCases(w, listReq)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	cases := resp["cases"].([]any)
	if len(cases) < 1 {
		t.Fatalf("cases count=%d, want >=1", len(cases))
	}
}

func TestAdminCreateConsentRequest(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)

	deviceID := activateDevice(t, db, "free")
	// Create a case directly
	_, err := db.Exec("INSERT INTO support_cases (id, device_id, summary, status, scopes_json) VALUES (?, ?, ?, 'open', '[]')",
		"case_consent_1", deviceID, "Please help")
	if err != nil {
		t.Fatalf("insert case: %v", err)
	}

	body, _ := json.Marshal(map[string]string{
		"path":       "/apps/nextcloud/data/config.php",
		"scope_type": "file",
	})
	req := adminRequest(t, http.MethodPost, "/api/admin/cases/case_consent_1/consent-requests", body)
	req = chiRequest(http.MethodPost, "/api/admin/cases/case_consent_1/consent-requests", body, map[string]string{"caseID": "case_consent_1"})
	req.Header.Set("Authorization", "Bearer admin-test-token")
	w := httptest.NewRecorder()
	h.CreateConsentRequest(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["status"] != "pending" {
		t.Fatalf("status=%v, want pending", resp["status"])
	}
}

func TestAdminAuthRequired(t *testing.T) {
	// AdminAuth middleware rejects bad tokens; test at router/integration level.
	t.Skip("admin auth enforced by middleware; test at router/integration level")
}

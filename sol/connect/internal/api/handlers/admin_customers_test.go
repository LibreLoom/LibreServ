package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func TestAdminListCustomerAccounts(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)
	activateDevice(t, db, "free")

	req := adminRequest(t, http.MethodGet, "/admin/accounts", nil)
	w := httptest.NewRecorder()
	h.ListCustomerAccounts(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	accounts := resp["accounts"].([]any)
	if len(accounts) != 1 {
		t.Fatalf("accounts count=%d, want 1", len(accounts))
	}
}

func TestAdminGetCustomerAccount(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)
	deviceID := activateDevice(t, db, "free")

	var accountID string
	if err := db.QueryRow("SELECT account_id FROM devices WHERE id = $1", deviceID).Scan(&accountID); err != nil {
		t.Fatalf("lookup account: %v", err)
	}

	req := chiRequest(http.MethodGet, "/admin/accounts/"+accountID, nil, map[string]string{"accountID": accountID})
	req.Header.Set("Authorization", "Bearer admin-test-token")
	w := httptest.NewRecorder()
	h.GetCustomerAccount(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
}

func TestAdminListConnectKeys(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)
	activateDevice(t, db, "free")

	req := adminRequest(t, http.MethodGet, "/admin/connect-keys", nil)
	w := httptest.NewRecorder()
	h.ListConnectKeys(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	keys := resp["connect_keys"].([]any)
	if len(keys) != 1 {
		t.Fatalf("connect_keys count=%d, want 1", len(keys))
	}
}

func TestAdminGenerateAndRevokeConnectKey(t *testing.T) {
	db := database.OpenTestDB(t)
	setAdminToken(t)
	h := NewAdminHandler(db)
	deviceID := activateDevice(t, db, "free")

	var accountID string
	if err := db.QueryRow("SELECT account_id FROM devices WHERE id = $1", deviceID).Scan(&accountID); err != nil {
		t.Fatalf("lookup account: %v", err)
	}

	body := []byte(`{"account_id":"` + accountID + `"}`)
	req := adminRequest(t, http.MethodPost, "/admin/connect-keys", body)
	w := httptest.NewRecorder()
	h.AdminGenerateConnectKey(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("generate status=%d: %s", w.Code, w.Body.String())
	}
	var generated map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &generated); err != nil {
		t.Fatalf("decode generate: %v", err)
	}
	if generated["connect_key"] == "" {
		t.Fatal("missing connect_key in response")
	}
	keyID := generated["key_id"].(string)

	revokeReq := chiRequest(http.MethodDelete, "/admin/connect-keys/"+keyID, nil, map[string]string{"keyID": keyID})
	revokeReq.Header.Set("Authorization", "Bearer admin-test-token")
	revokeW := httptest.NewRecorder()
	h.AdminRevokeConnectKey(revokeW, revokeReq)
	if revokeW.Code != http.StatusOK {
		t.Fatalf("revoke status=%d: %s", revokeW.Code, revokeW.Body.String())
	}
}

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestAdminStatsAndDevices(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	_, code, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "order-1")
	if err != nil {
		t.Fatal(err)
	}
	_ = code
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_1', 'a@b.co', 'x', 0, 'none', 1, ?)`, time.Now().Unix())

	rec := httptest.NewRecorder()
	h.Accounts(rec, httptest.NewRequest(http.MethodGet, "/admin/accounts", nil))
	if rec.Code != 200 {
		t.Fatalf("accounts %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.Stats(rec, httptest.NewRequest(http.MethodGet, "/admin/stats", nil))
	if rec.Code != 200 {
		t.Fatalf("stats %d", rec.Code)
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["devices"].(float64) < 1 {
		t.Fatalf("devices %v", body)
	}

	rec2 := httptest.NewRecorder()
	h.SetupTokens(rec2, httptest.NewRequest(http.MethodGet, "/admin/setup-tokens", nil))
	if rec2.Code != 200 {
		t.Fatalf("tokens %d %s", rec2.Code, rec2.Body.String())
	}
}

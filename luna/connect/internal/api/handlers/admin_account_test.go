package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

func TestAdminGetAccount(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_detail', 'detail@b.co', 'x', 1, 'active', 1, ?)`, now)

	id, _, _, err := insertDeviceIdentity(d.DB, "official", "order-detail")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'bound', account_id = 'acct_detail', subdomain = 'myluna' WHERE id = ?`, id)

	req := httptest.NewRequest(http.MethodGet, "/admin/accounts/acct_detail", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("accountID", "acct_detail")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	rec := httptest.NewRecorder()
	h.GetAccount(rec, req)
	if rec.Code != 200 {
		t.Fatalf("get account %d %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() == "" || rec.Body.String()[0] != '{' {
		t.Fatalf("unexpected body %s", rec.Body.String())
	}
}

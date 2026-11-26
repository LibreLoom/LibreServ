package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestAdminStatsAndDevices(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	_, token, err := insertDeviceIdentity(d.DB, "official", "order-1")
	if err != nil {
		t.Fatal(err)
	}
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
	h.DeviceCodes(rec2, httptest.NewRequest(http.MethodGet, "/admin/device-codes", nil))
	if rec2.Code != 200 {
		t.Fatalf("tokens %d %s", rec2.Code, rec2.Body.String())
	}
	var tokBody map[string]any
	_ = json.Unmarshal(rec2.Body.Bytes(), &tokBody)
	tokens, _ := tokBody["tokens"].([]any)
	if len(tokens) < 1 {
		t.Fatalf("expected tokens, got %v", tokBody)
	}
	row, _ := tokens[0].(map[string]any)
	// Connect keeps only a hash of the token, so no list row can carry it or
	// offer to reveal it.
	if strings.Contains(rec2.Body.String(), token) {
		t.Fatalf("list leaked the full device token: %v", row)
	}
	for _, leaked := range []string{"code", "device_token", "device_uid", "verification_code", "can_reveal", "device_code_prefix"} {
		if _, has := row[leaked]; has {
			t.Fatalf("list row has %q: %v", leaked, row)
		}
	}
	if row["hint"] != security.TokenHint(token) {
		t.Fatalf("hint %v want %v", row["hint"], security.TokenHint(token))
	}
}

func TestDeviceCodesPaginationAndSearch(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}

	// Insert 5 identities: 2 unbound, 2 bound, 1 revoked.
	id1, tok1, _ := insertDeviceIdentity(d.DB, "official", "order-alpha")
	id2, _, _ := insertDeviceIdentity(d.DB, "official", "order-beta")
	id3, _, _ := insertDeviceIdentity(d.DB, "official", "order-gamma")
	id4, _, _ := insertDeviceIdentity(d.DB, "official", "order-delta")
	id5, _, _ := insertDeviceIdentity(d.DB, "official", "order-epsilon")

	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_search', 'tester@example.com', 'x', 0, 'none', 1, ?)`, now)

	// Bind id3 and id4 to acct_search, set subdomain for id3
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'bound', account_id = 'acct_search', subdomain = 'myluna' WHERE id = ?`, id3)
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'bound', account_id = 'acct_search' WHERE id = ?`, id4)
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'revoked', revoked = 1 WHERE id = ?`, id5)

	// Test 1: Pagination (limit=2, offset=0)
	rec := httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?limit=2&offset=0", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	var page1 map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &page1)
	tokens1 := page1["tokens"].([]any)
	if len(tokens1) != 2 {
		t.Fatalf("expected 2 tokens, got %d", len(tokens1))
	}
	pag1 := page1["pagination"].(map[string]any)
	if pag1["total"].(float64) != 5 || pag1["has_more"].(bool) != true {
		t.Fatalf("unexpected pagination: %+v", pag1)
	}

	// Test 2: Search by the hint (last four characters of the token).
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?q="+tok1[16:], nil))
	var searchRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &searchRes)
	stList := searchRes["tokens"].([]any)
	if len(stList) != 1 || stList[0].(map[string]any)["id"] != id1 {
		t.Fatalf("expected to find id1 for the hint search, got %v", searchRes)
	}

	// Test 3: Search by subdomain ("myluna")
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?q=myluna", nil))
	var subRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &subRes)
	subList := subRes["tokens"].([]any)
	if len(subList) != 1 || subList[0].(map[string]any)["id"] != id3 {
		t.Fatalf("expected to find id3 for subdomain search, got %v", subRes)
	}

	// Test 4: Search by account email ("tester@example.com")
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?q=tester@example.com", nil))
	var emailRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &emailRes)
	emailList := emailRes["tokens"].([]any)
	if len(emailList) != 2 {
		t.Fatalf("expected 2 tokens for tester@example.com, got %d", len(emailList))
	}

	// Test 5: Status filter - unbound
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?status=unbound", nil))
	var unbRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &unbRes)
	unbList := unbRes["tokens"].([]any)
	if len(unbList) != 2 {
		t.Fatalf("expected 2 unbound tokens, got %d", len(unbList))
	}
	if unbRes["pagination"].(map[string]any)["total"].(float64) != 2 {
		t.Fatalf("expected total 2, got %v", unbRes["pagination"])
	}

	// Test 6: Status filter - bound
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?status=bound", nil))
	var bndRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &bndRes)
	bndList := bndRes["tokens"].([]any)
	if len(bndList) != 2 {
		t.Fatalf("expected 2 bound tokens, got %d", len(bndList))
	}

	// Test 7: Status filter - revoked
	rec = httptest.NewRecorder()
	h.DeviceCodes(rec, httptest.NewRequest(http.MethodGet, "/admin/device-codes?status=revoked", nil))
	var revRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &revRes)
	revList := revRes["tokens"].([]any)
	if len(revList) != 1 || revList[0].(map[string]any)["id"] != id5 {
		t.Fatalf("expected 1 revoked token (id5), got %v", revRes)
	}

	_ = id2
}

func TestAccountsPaginationAndSearch(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}

	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_p1', 'alpha@domain.com', 'x', 0, 'none', 1, ?),
       ('acct_p2', 'beta@domain.com', 'x', 0, 'none', 1, ?),
       ('acct_p3', 'gamma@domain.com', 'x', 0, 'none', 1, ?)`, now, now+1, now+2)

	// Link a device to acct_p2 with subdomain 'box2'
	devID, _, _ := insertDeviceIdentity(d.DB, "official", "order-acc")
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'bound', account_id = 'acct_p2', subdomain = 'box2' WHERE id = ?`, devID)

	// Test 1: Pagination (limit=2, offset=0)
	rec := httptest.NewRecorder()
	h.Accounts(rec, httptest.NewRequest(http.MethodGet, "/admin/accounts?limit=2&offset=0", nil))
	if rec.Code != 200 {
		t.Fatalf("accounts status %d", rec.Code)
	}
	var res map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	accts := res["accounts"].([]any)
	if len(accts) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(accts))
	}
	pag := res["pagination"].(map[string]any)
	if pag["total"].(float64) != 3 || pag["has_more"].(bool) != true {
		t.Fatalf("unexpected pagination: %+v", pag)
	}

	// Test 2: Search by email
	rec = httptest.NewRecorder()
	h.Accounts(rec, httptest.NewRequest(http.MethodGet, "/admin/accounts?q=beta", nil))
	var sRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &sRes)
	sAccts := sRes["accounts"].([]any)
	if len(sAccts) != 1 || sAccts[0].(map[string]any)["id"] != "acct_p2" {
		t.Fatalf("expected acct_p2, got %v", sRes)
	}
	if sRes["pagination"].(map[string]any)["total"].(float64) != 1 {
		t.Fatalf("expected total 1, got %v", sRes["pagination"])
	}

	// Test 3: Search by linked device subdomain
	rec = httptest.NewRecorder()
	h.Accounts(rec, httptest.NewRequest(http.MethodGet, "/admin/accounts?q=box2", nil))
	var dRes map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &dRes)
	dAccts := dRes["accounts"].([]any)
	if len(dAccts) != 1 || dAccts[0].(map[string]any)["id"] != "acct_p2" {
		t.Fatalf("expected acct_p2 via box2, got %v", dRes)
	}
}

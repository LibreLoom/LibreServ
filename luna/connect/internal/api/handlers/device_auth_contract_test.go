package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func statusWithToken(devH DeviceHandler, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(rec, req)
	return rec
}

func assertDeviceCredentialError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("credential status=%d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	var out struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Error == "" || out.Error != out.Message {
		t.Fatalf("credential error is not generic: %s", rec.Body.String())
	}
	if out.Code != code {
		t.Fatalf("credential code=%q, want %q: %s", out.Code, code, rec.Body.String())
	}
	message := strings.ToLower(out.Error)
	if strings.Contains(message, "unbound") || strings.Contains(message, "revoked") {
		t.Fatalf("credential message exposed device state: %q", out.Error)
	}
}

func TestDeviceAuthInvalidAndUnknownTokensReturnUnauthorized(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	for _, token := range []string{"", "not-a-token", security.AuthToken()} {
		assertDeviceCredentialError(t, statusWithToken(devH, token), http.StatusUnauthorized, "")
	}
}

func TestRollingTokenRotationAndLostResponseOverlap(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "rotate@b.co")
	verifyEmailFor(t, acctH, "rotate@b.co")
	_, uid, code := mintDevice(t, d, "official")
	_, first := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	now := time.Now().Unix()

	second, err := refreshDeviceToken(context.Background(), d.DB, first, now)
	if err != nil || second == first || !security.ValidAuthToken(second) {
		t.Fatalf("first rotation second=%q err=%v", second, err)
	}
	if rec := statusWithToken(devH, first); rec.Code != http.StatusUnauthorized {
		t.Fatalf("previous token worked on status: %d", rec.Code)
	}
	if rec := statusWithToken(devH, second); rec.Code != http.StatusOK {
		t.Fatalf("rotated token failed status: %d %s", rec.Code, rec.Body.String())
	}
	if rec := statusWithToken(devH, second); rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status cache control=%q", rec.Header().Get("Cache-Control"))
	}
	retry, err := refreshDeviceToken(context.Background(), d.DB, first, now+30)
	if err != nil || retry != second {
		t.Fatalf("lost-response retry did not return current token: retry=%q want=%q err=%v", retry, second, err)
	}

	third, err := refreshDeviceToken(context.Background(), d.DB, second, now+40)
	if err != nil || third == second {
		t.Fatalf("second rotation third=%q err=%v", third, err)
	}
	if _, err := refreshDeviceToken(context.Background(), d.DB, first, now+50); err == nil {
		t.Fatal("two-generation-old token remained in overlap")
	}
	if rec := statusWithToken(devH, second); rec.Code != http.StatusUnauthorized {
		t.Fatalf("rotated-out token worked on status: %d", rec.Code)
	}
	if rec := statusWithToken(devH, third); rec.Code != http.StatusOK {
		t.Fatalf("latest token failed status: %d", rec.Code)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET previous_auth_token_valid_until = ? WHERE device_uid = ?`, now-1, uid)
	if _, err := refreshDeviceToken(context.Background(), d.DB, second, now); err == nil {
		t.Fatal("expired overlap token was accepted")
	}
}

func TestUnbindAndRevokeInvalidateImmediatelyAndRecoveryRequiresPassword(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "recover@b.co")
	verifyEmailFor(t, acctH, "recover@b.co")
	devID, uid, code := mintDevice(t, d, "official")
	_, first := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	rotated, err := refreshDeviceToken(context.Background(), d.DB, first, time.Now().Unix())
	if err != nil || rotated == first {
		t.Fatalf("rotation before unbind token=%q err=%v", rotated, err)
	}
	assertDeviceCredentialError(t, statusWithToken(devH, first), http.StatusUnauthorized, "")

	unbind := httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil)
	unbind.AddCookie(cookie)
	unbind = withChiParam(unbind, "deviceID", devID)
	if rec := withVerifiedAccount(acctH, devH.Unbind, unbind); rec.Code != http.StatusOK {
		t.Fatalf("unbind %d %s", rec.Code, rec.Body.String())
	}
	assertDeviceCredentialError(t, statusWithToken(devH, first), http.StatusForbidden, deviceUnboundCode)
	assertDeviceCredentialError(t, statusWithToken(devH, rotated), http.StatusForbidden, deviceUnboundCode)
	if _, err := refreshDeviceToken(context.Background(), d.DB, first, time.Now().Unix()); !errors.Is(err, errDeviceUnbound) {
		t.Fatalf("unbound previous token refresh error=%v", err)
	}
	if _, err := refreshDeviceToken(context.Background(), d.DB, rotated, time.Now().Unix()); !errors.Is(err, errDeviceUnbound) {
		t.Fatalf("unbound current token refresh error=%v", err)
	}

	_, second := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	revokeReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/revoke", nil)
	revokeReq.AddCookie(cookie)
	revokeReq = withChiParam(revokeReq, "deviceID", devID)
	if rec := withVerifiedAccount(acctH, devH.Revoke, revokeReq); rec.Code != http.StatusOK {
		t.Fatalf("revoke %d %s", rec.Code, rec.Body.String())
	}
	assertDeviceCredentialError(t, statusWithToken(devH, second), http.StatusForbidden, deviceRevokedCode)
	if _, err := refreshDeviceToken(context.Background(), d.DB, second, time.Now().Unix()); !errors.Is(err, errDeviceRevoked) {
		t.Fatalf("revoked token refresh error=%v", err)
	}

	recover := func(password string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"password": password})
		req := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/recover", bytes.NewReader(body))
		req.AddCookie(cookie)
		req = withChiParam(req, "deviceID", devID)
		return withVerifiedAccount(acctH, devH.Recover, req)
	}
	if rec := recover("wrong-password-1"); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong recovery password %d %s", rec.Code, rec.Body.String())
	}
	var state string
	_ = d.DB.QueryRow(`SELECT state FROM devices WHERE id = ?`, devID).Scan(&state)
	if state != "revoked" {
		t.Fatalf("wrong password changed state to %s", state)
	}
	recovered := recover("hunter22hunter1")
	if recovered.Code != http.StatusOK {
		t.Fatalf("recover %d %s", recovered.Code, recovered.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(recovered.Body.Bytes(), &out)
	pairingID, _ := out["pairing_id"].(string)
	if status := pairingStatusRequest(t, acctH, devH, cookie, pairingID); status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"waiting"`) {
		t.Fatalf("recovery pairing status %d %s", status.Code, status.Body.String())
	}
	claim := claimPairRequest(devH, uid, code)
	if claim.Code != http.StatusOK {
		t.Fatalf("recovery claim %d %s", claim.Code, claim.Body.String())
	}
}

func TestLegacyPermanentTokenRejectedOnEveryDeviceRoute(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "legacy@b.co")
	verifyEmailFor(t, acctH, "legacy@b.co")
	_, uid, code := mintDevice(t, d, "official")
	_, current := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	legacy := security.DeviceUID()
	_, _ = d.DB.Exec(`UPDATE devices SET code_hash = ? WHERE device_uid = ?`, security.HashToken(legacy), uid)

	status := httptest.NewRequest(http.MethodGet, "/status", nil)
	status.Header.Set("Authorization", "Bearer "+legacy)
	domain := httptest.NewRequest(http.MethodPost, "/domain", strings.NewReader(`{"subdomain":"legacy-box"}`))
	domain.Header.Set("Authorization", "Bearer "+legacy)
	unregister := httptest.NewRequest(http.MethodPost, "/unregister", nil)
	unregister.Header.Set("Authorization", "Bearer "+legacy)
	for _, req := range []*http.Request{status, domain, unregister} {
		rec := httptest.NewRecorder()
		devH.DeviceAuth(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		})).ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("legacy token reached %s: %d", req.URL.Path, rec.Code)
		}
	}

	storage := storageRouter(d)
	usage := httptest.NewRequest(http.MethodGet, "/storage/usage", nil)
	usage.Header.Set("Authorization", "Bearer "+legacy)
	usage.Header.Set("X-Luna-Id", "legacy-luna")
	usageRec := httptest.NewRecorder()
	storage.ServeHTTP(usageRec, usage)
	if usageRec.Code != http.StatusUnauthorized {
		t.Fatalf("legacy storage token %d %s", usageRec.Code, usageRec.Body.String())
	}
	signing := httptest.NewRequest(http.MethodPost, "/storage/luna-ids/legacy-luna/signing-public", strings.NewReader(strings.Repeat("a", 128)))
	signing.Header.Set("Authorization", "Bearer "+legacy)
	signing = withChiParam(signing, "id", "legacy-luna")
	signingRec := httptest.NewRecorder()
	storage.ServeHTTP(signingRec, signing)
	if signingRec.Code != http.StatusUnauthorized {
		t.Fatalf("legacy signing token %d %s", signingRec.Code, signingRec.Body.String())
	}
	if rec := statusWithToken(devH, current); rec.Code != http.StatusOK {
		t.Fatalf("current token regressed: %d", rec.Code)
	}
}

func issueGrant(t *testing.T, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, deviceID string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/devices/"+deviceID+"/setup-grant", nil)
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", deviceID)
	rec := withVerifiedAccount(acctH, devH.IssueSetupGrant, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("issue grant %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func consumeGrant(devH DeviceHandler, token, grant string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"setup_grant": grant})
	req := httptest.NewRequest(http.MethodPost, "/devices/setup-grant/consume", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.ConsumeSetupGrant)).ServeHTTP(rec, req)
	return rec
}

func TestSetupGrantSingleUseReplacementExpiryAndFragmentURL(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "grant@b.co")
	verifyEmailFor(t, acctH, "grant@b.co")
	_, uid, code := mintDevice(t, d, "official")
	devID, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

	first := issueGrant(t, acctH, devH, cookie, devID)
	grant1, _ := first["setup_grant"].(string)
	if !security.ValidAuthToken(grant1) {
		t.Fatalf("invalid grant %q", grant1)
	}
	second := issueGrant(t, acctH, devH, cookie, devID)
	grant2, _ := second["setup_grant"].(string)
	if grant2 == grant1 || consumeGrant(devH, token, grant1).Code != http.StatusBadRequest {
		t.Fatal("issuing a new grant did not invalidate the previous one")
	}
	if rec := consumeGrant(devH, token, grant2); rec.Code != http.StatusOK {
		t.Fatalf("consume %d %s", rec.Code, rec.Body.String())
	}
	if rec := consumeGrant(devH, token, grant2); rec.Code != http.StatusBadRequest {
		t.Fatalf("grant replay %d %s", rec.Code, rec.Body.String())
	}

	third := issueGrant(t, acctH, devH, cookie, devID)
	grant3, _ := third["setup_grant"].(string)
	_, _ = d.DB.Exec(`UPDATE device_setup_grants SET expires_at = ? WHERE device_id = ?`, time.Now().Unix()-1, devID)
	if rec := consumeGrant(devH, token, grant3); rec.Code != http.StatusBadRequest {
		t.Fatalf("expired grant %d %s", rec.Code, rec.Body.String())
	}

	_, _ = d.DB.Exec(`UPDATE devices SET subdomain = 'grantbox' WHERE id = ?`, devID)
	withURL := issueGrant(t, acctH, devH, cookie, devID)
	setupURL, _ := withURL["setup_url"].(string)
	parsed, err := url.Parse(setupURL)
	if err != nil || parsed.Path != "/setup" || parsed.RawQuery != "" || parsed.Fragment != "setup_grant="+withURL["setup_grant"].(string) {
		t.Fatalf("setup grant leaked into query or wrong fragment: %q", setupURL)
	}
}

func TestProvisioningOutputsUIDAndVerificationCode(t *testing.T) {
	d := testDeps(t)
	onb := OnboardingHandler{Deps: d}
	single := httptest.NewRecorder()
	onb.AdminMint(single, httptest.NewRequest(http.MethodPost, "/admin/device-codes", strings.NewReader(`{}`)))
	if single.Code != http.StatusCreated {
		t.Fatalf("single mint %d %s", single.Code, single.Body.String())
	}
	if single.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("single mint cache control=%q", single.Header().Get("Cache-Control"))
	}
	var one map[string]any
	_ = json.Unmarshal(single.Body.Bytes(), &one)
	if !security.IsDeviceUIDShape(security.NormalizeDeviceUID(one["device_uid"].(string))) || !security.IsVerificationCodeShape(one["verification_code"].(string)) {
		t.Fatalf("single provisioning output: %v", one)
	}

	bulk := httptest.NewRecorder()
	onb.AdminMintBulk(bulk, httptest.NewRequest(http.MethodPost, "/admin/device-codes/bulk", strings.NewReader(`{"count":2}`)))
	if bulk.Code != http.StatusCreated {
		t.Fatalf("bulk mint %d %s", bulk.Code, bulk.Body.String())
	}
	if bulk.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("bulk mint cache control=%q", bulk.Header().Get("Cache-Control"))
	}
	var many map[string]any
	_ = json.Unmarshal(bulk.Body.Bytes(), &many)
	lines := many["tokens"].([]any)
	if len(lines) != 2 {
		t.Fatalf("bulk lines: %v", lines)
	}
	for _, raw := range lines {
		fields := strings.Fields(raw.(string))
		if len(fields) != 2 || !security.IsDeviceUIDShape(fields[0]) || !security.IsVerificationCodeShape(fields[1]) {
			t.Fatalf("factory TOKENS line %q", raw)
		}
	}
}

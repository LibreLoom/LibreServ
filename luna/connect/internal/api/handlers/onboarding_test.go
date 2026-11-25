package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestOnboardingStatusSkipsCodeWhenBound(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "bound@b.co")
	verifyEmailFor(t, acctH, "bound@b.co")

	_, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_path = 'official', onboarding_step = 'code' WHERE email = ?`, "bound@b.co")

	statusReq := httptest.NewRequest(http.MethodGet, "/onboarding/status", nil)
	statusReq.AddCookie(cookie)
	statusRec := withVerifiedAccount(acctH, onbH.Status, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status %d %s", statusRec.Code, statusRec.Body.String())
	}
	var status map[string]any
	_ = json.Unmarshal(statusRec.Body.Bytes(), &status)
	if status["step"] != "domain" {
		t.Fatalf("expected domain step, got %v", status["step"])
	}
	if status["skip_code_entry"] != true {
		t.Fatalf("expected skip_code_entry true, got %v", status["skip_code_entry"])
	}

	meReq := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	meReq.AddCookie(cookie)
	meRec := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(acctH.Me)).ServeHTTP(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("me %d %s", meRec.Code, meRec.Body.String())
	}
	var me map[string]any
	_ = json.Unmarshal(meRec.Body.Bytes(), &me)
	if me["onboarding_step"] != "domain" {
		t.Fatalf("me step: %v", me["onboarding_step"])
	}
	if me["has_bound_device"] != true {
		t.Fatalf("me has_bound_device: %v", me["has_bound_device"])
	}
}

func bindMintedLuna(t *testing.T, d Deps, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie) string {
	t.Helper()
	_, code := mintDevice(t, d, "official")
	req := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, devH.Bind, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		DeviceID string `json:"device_id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.DeviceID
}

func TestBindAllowsSeveralLunasOnOneAccount(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "many@b.co")
	verifyEmailFor(t, acctH, "many@b.co")

	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)
	if first == second || second == "" {
		t.Fatalf("expected two distinct device ids, got %q and %q", first, second)
	}
	var n int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM device_onboarding WHERE account_id = (SELECT id FROM accounts WHERE email = ?)`, "many@b.co").Scan(&n)
	if n != 2 {
		t.Fatalf("two Lunas should have their own progress rows, got %d", n)
	}
}

func TestOnboardingProgressIsPerLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "steps@b.co")
	verifyEmailFor(t, acctH, "steps@b.co")
	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)

	body := `{"path":"official","step":"backup","device_id":"` + first + `"}`
	progReq := httptest.NewRequest(http.MethodPost, "/onboarding/progress", bytes.NewBufferString(body))
	progReq.AddCookie(cookie)
	progRec := withVerifiedAccount(acctH, onbH.SetOnboardingProgress, progReq)
	if progRec.Code != http.StatusOK {
		t.Fatalf("progress %d %s", progRec.Code, progRec.Body.String())
	}

	for _, tc := range []struct{ deviceID, want string }{{first, "backup"}, {second, "domain"}} {
		req := httptest.NewRequest(http.MethodGet, "/onboarding/status?device_id="+tc.deviceID, nil)
		req.AddCookie(cookie)
		rec := withVerifiedAccount(acctH, onbH.Status, req)
		var status map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &status)
		if status["step"] != tc.want {
			t.Fatalf("device %s step = %v, want %s", tc.deviceID, status["step"], tc.want)
		}
	}

	meReq := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	meReq.AddCookie(cookie)
	meRec := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(acctH.Me)).ServeHTTP(meRec, meReq)
	var me struct {
		Devices []struct {
			DeviceID string `json:"device_id"`
			Step     string `json:"step"`
		} `json:"onboarding_devices"`
	}
	_ = json.Unmarshal(meRec.Body.Bytes(), &me)
	if len(me.Devices) != 2 {
		t.Fatalf("me should list two Lunas, got %d", len(me.Devices))
	}
	for _, dev := range me.Devices {
		want := "domain"
		if dev.DeviceID == first {
			want = "backup"
		}
		if dev.Step != want {
			t.Fatalf("me device %s step = %q, want %q", dev.DeviceID, dev.Step, want)
		}
	}
}

func TestUnbindLeavesOtherLunaProgressAlone(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "unbindtwo@b.co")
	verifyEmailFor(t, acctH, "unbindtwo@b.co")
	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)
	_, _ = d.DB.Exec(`UPDATE device_onboarding SET step = 'backup' WHERE device_id = ?`, first)

	req := httptest.NewRequest(http.MethodDelete, "/devices/"+second, nil)
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", second)
	rec := withVerifiedAccount(acctH, devH.Unbind, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unbind %d %s", rec.Code, rec.Body.String())
	}

	var step string
	if err := d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, first).Scan(&step); err != nil || step != "backup" {
		t.Fatalf("first Luna progress = %q, %v", step, err)
	}
	var gone int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM device_onboarding WHERE device_id = ?`, second).Scan(&gone)
	if gone != 0 {
		t.Fatalf("unbound Luna's progress was kept")
	}
	var accountStep string
	_ = d.DB.QueryRow(`SELECT onboarding_step FROM accounts WHERE email = ?`, "unbindtwo@b.co").Scan(&accountStep)
	if accountStep == "code" {
		t.Fatalf("unbinding one Luna reset the account-wide mirror")
	}
}

func TestOnboardingProgressRejectsAnotherAccountsLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	ownerCookie := registerAccount(t, acctH, "owner@b.co")
	verifyEmailFor(t, acctH, "owner@b.co")
	otherCookie := registerAccount(t, acctH, "other@b.co")
	verifyEmailFor(t, acctH, "other@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, ownerCookie)

	body := `{"path":"official","step":"backup","device_id":"` + devID + `"}`
	req := httptest.NewRequest(http.MethodPost, "/onboarding/progress", bytes.NewBufferString(body))
	req.AddCookie(otherCookie)
	rec := withVerifiedAccount(acctH, onbH.SetOnboardingProgress, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("foreign device progress = %d %s", rec.Code, rec.Body.String())
	}
	var step string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, devID).Scan(&step)
	if step != "domain" {
		t.Fatalf("foreign account changed progress to %q", step)
	}
}

func TestUnbindResetsOnboardingToCode(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "unbind@b.co")
	verifyEmailFor(t, acctH, "unbind@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	withVerifiedAccount(acctH, devH.Bind, bindReq)

	unReq := httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil)
	unReq.AddCookie(cookie)
	unReq = withChiParam(unReq, "deviceID", devID)
	unRec := withVerifiedAccount(acctH, devH.Unbind, unReq)
	if unRec.Code != http.StatusOK {
		t.Fatalf("unbind %d", unRec.Code)
	}

	var step string
	_ = d.DB.QueryRow(`SELECT onboarding_step FROM accounts WHERE email = ?`, "unbind@b.co").Scan(&step)
	if step != "code" {
		t.Fatalf("onboarding_step after unbind: %s", step)
	}
}

func accountIDFor(t *testing.T, d Deps, email string) string {
	t.Helper()
	var id string
	if err := d.DB.QueryRow(`SELECT id FROM accounts WHERE email = ?`, email).Scan(&id); err != nil {
		t.Fatalf("account %s: %v", email, err)
	}
	return id
}

func TestDeviceBindCapMatchesStorageCap(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "cap@b.co")
	verifyEmailFor(t, acctH, "cap@b.co")
	acctID := accountIDFor(t, d, "cap@b.co")
	for i := 0; i < MaxLunasPerAccount; i++ {
		id, _ := mintDevice(t, d, "official")
		claimed, err := claimDevice(d.DB, id, acctID)
		if err != nil || !claimed {
			t.Fatalf("claim %d: claimed=%v err=%v", i, claimed, err)
		}
	}
	id, code := mintDevice(t, d, "official")
	if claimed, err := claimDevice(d.DB, id, acctID); !errors.Is(err, errAccountFull) || claimed {
		t.Fatalf("claim over cap: claimed=%v err=%v", claimed, err)
	}
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusConflict || !bytes.Contains(bindRec.Body.Bytes(), []byte("Unbind a Luna")) {
		t.Fatalf("bind over cap = %d %s", bindRec.Code, bindRec.Body.String())
	}
	rec := httptest.NewRecorder()
	writeLunaBindError(rec, errLunaLimit)
	if !bytes.Contains(rec.Body.Bytes(), []byte("Delete the backups of one")) {
		t.Fatalf("storage cap error should say what to do: %s", rec.Body.String())
	}
}

func TestStatusAndMeRejectAnotherAccountsLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	owner := registerAccount(t, acctH, "statusowner@b.co")
	verifyEmailFor(t, acctH, "statusowner@b.co")
	other := registerAccount(t, acctH, "statusother@b.co")
	verifyEmailFor(t, acctH, "statusother@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, owner)

	for _, tc := range []struct {
		name   string
		method string
		path   string
		run    func(r *http.Request) *httptest.ResponseRecorder
	}{
		{"status", http.MethodGet, "/onboarding/status?device_id=" + devID, func(r *http.Request) *httptest.ResponseRecorder {
			return withVerifiedAccount(acctH, onbH.Status, r)
		}},
		{"me", http.MethodGet, "/account/me?device_id=" + devID, func(r *http.Request) *httptest.ResponseRecorder {
			rec := httptest.NewRecorder()
			acctH.AccountAuth(http.HandlerFunc(acctH.Me)).ServeHTTP(rec, r)
			return rec
		}},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.AddCookie(other)
		if rec := tc.run(req); rec.Code != http.StatusNotFound {
			t.Fatalf("%s with foreign device = %d %s", tc.name, rec.Code, rec.Body.String())
		}
	}
}

func TestSetDomainAdvancesOnlyTheNamedLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "domain@b.co")
	verifyEmailFor(t, acctH, "domain@b.co")
	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)

	req := httptest.NewRequest(http.MethodPost, "/devices/"+second+"/domain", bytes.NewBufferString(`{"subdomain":"pantry"}`))
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", second)
	if rec := withVerifiedAccount(acctH, devH.SetDomain, req); rec.Code != http.StatusOK && rec.Code != http.StatusCreated {
		t.Fatalf("domain %d %s", rec.Code, rec.Body.String())
	}
	var firstStep, secondStep string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, first).Scan(&firstStep)
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, second).Scan(&secondStep)
	if firstStep != "domain" || secondStep != "backup" {
		t.Fatalf("domain steps: first=%q second=%q", firstStep, secondStep)
	}
}

func TestAddingDIYKeepsItsOwnPath(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "add-diy@b.co")
	verifyEmailFor(t, acctH, "add-diy@b.co")
	_ = bindMintedLuna(t, d, acctH, devH, cookie)

	mintReq := httptest.NewRequest(http.MethodPost, "/account/diy-token", bytes.NewBufferString(`{}`))
	mintReq.AddCookie(cookie)
	mintRec := withVerifiedAccount(acctH, onbH.MintDIY, mintReq)
	if mintRec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", mintRec.Code, mintRec.Body.String())
	}
	var minted struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(mintRec.Body.Bytes(), &minted)
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+minted.Code+`"}`))
	bindReq.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, devH.Bind, bindReq); rec.Code != http.StatusOK {
		t.Fatalf("bind diy %d %s", rec.Code, rec.Body.String())
	}
	var path, step string
	_ = d.DB.QueryRow(`SELECT COALESCE(path,''), COALESCE(step,'') FROM device_onboarding WHERE device_id = (SELECT id FROM devices WHERE code_hash = ?)`, security.HashToken(security.NormalizeToken(minted.Code))).Scan(&path, &step)
	if path != "diy" || step != "domain" {
		t.Fatalf("added DIY Luna progress = %q/%q, want diy/domain", path, step)
	}

	// Adding a retail Luna afterwards must not inherit the DIY path from the
	// account mirror.
	_, officialCode := mintDevice(t, d, "official")
	retailReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+officialCode+`"}`))
	retailReq.AddCookie(cookie)
	retailRec := withVerifiedAccount(acctH, devH.Bind, retailReq)
	if retailRec.Code != http.StatusOK {
		t.Fatalf("bind retail %d %s", retailRec.Code, retailRec.Body.String())
	}
	var retailPath string
	_ = d.DB.QueryRow(`SELECT COALESCE(path,'') FROM device_onboarding WHERE device_id = (SELECT id FROM devices WHERE code_hash = ?)`, security.HashToken(security.NormalizeToken(officialCode))).Scan(&retailPath)
	if retailPath != "official" {
		t.Fatalf("added retail Luna path = %q, want official", retailPath)
	}
}

func TestScopedReadLeavesLegacyMirrorAlone(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "mirror@b.co")
	verifyEmailFor(t, acctH, "mirror@b.co")
	_ = bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)
	_, _ = d.DB.Exec(`UPDATE device_onboarding SET step = 'backup' WHERE device_id = ?`, second)
	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_step = 'domain' WHERE email = ?`, "mirror@b.co")

	req := httptest.NewRequest(http.MethodGet, "/onboarding/status?device_id="+second, nil)
	req.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, onbH.Status, req); rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var mirror string
	_ = d.DB.QueryRow(`SELECT onboarding_step FROM accounts WHERE email = ?`, "mirror@b.co").Scan(&mirror)
	if mirror != "domain" {
		t.Fatalf("device-scoped read changed mirror to %q", mirror)
	}
}

func TestEmptyStepPreservesProgress(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "empty@b.co")
	verifyEmailFor(t, acctH, "empty@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, cookie)
	_, _ = d.DB.Exec(`UPDATE device_onboarding SET step = 'backup' WHERE device_id = ?`, devID)

	req := httptest.NewRequest(http.MethodPost, "/onboarding/progress", bytes.NewBufferString(`{"device_id":"`+devID+`"}`))
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, onbH.SetOnboardingProgress, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("progress %d %s", rec.Code, rec.Body.String())
	}
	var step string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, devID).Scan(&step)
	if step != "backup" {
		t.Fatalf("empty step wiped progress to %q", step)
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["step"] != "backup" {
		t.Fatalf("response step = %v, want preserved backup", body["step"])
	}
}

func TestBackupsRejectsAnotherAccountsLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	owner := registerAccount(t, acctH, "backupsowner@b.co")
	verifyEmailFor(t, acctH, "backupsowner@b.co")
	other := registerAccount(t, acctH, "backupsother@b.co")
	verifyEmailFor(t, acctH, "backupsother@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, owner)

	req := httptest.NewRequest(http.MethodPost, "/onboarding/backups", bytes.NewBufferString(`{"device_id":"`+devID+`"}`))
	req.AddCookie(other)
	if rec := withVerifiedAccount(acctH, onbH.Backups, req); rec.Code != http.StatusNotFound {
		t.Fatalf("backups with foreign device = %d %s", rec.Code, rec.Body.String())
	}
}

func TestLegacyProgressWriteTargetsOldestLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "legacy@b.co")
	verifyEmailFor(t, acctH, "legacy@b.co")
	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)
	// Device IDs are random and created_at has second resolution, so pin the
	// order this test depends on instead of relying on the tie-break.
	_, _ = d.DB.Exec(`UPDATE devices SET created_at = 100 WHERE id = ?`, first)
	_, _ = d.DB.Exec(`UPDATE devices SET created_at = 200 WHERE id = ?`, second)

	req := httptest.NewRequest(http.MethodPost, "/onboarding/progress", bytes.NewBufferString(`{"path":"official","step":"backup"}`))
	req.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, onbH.SetOnboardingProgress, req); rec.Code != http.StatusOK {
		t.Fatalf("progress %d %s", rec.Code, rec.Body.String())
	}
	var firstStep, secondStep string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, first).Scan(&firstStep)
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, second).Scan(&secondStep)
	if firstStep != "backup" || secondStep != "domain" {
		t.Fatalf("legacy write: first=%q second=%q", firstStep, secondStep)
	}
}

func TestLegacyRowBackfillsFromAccountMirror(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "backfill@b.co")
	verifyEmailFor(t, acctH, "backfill@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, cookie)
	_, _ = d.DB.Exec(`DELETE FROM device_onboarding WHERE device_id = ?`, devID)
	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_path = 'diy', onboarding_step = 'backup' WHERE email = ?`, "backfill@b.co")

	req := httptest.NewRequest(http.MethodGet, "/onboarding/status", nil)
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, onbH.Status, req)
	var status map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["step"] != "backup" {
		t.Fatalf("backfilled status = %v", status["step"])
	}
	var path, step string
	if err := d.DB.QueryRow(`SELECT COALESCE(path,''), COALESCE(step,'') FROM device_onboarding WHERE device_id = ?`, devID).Scan(&path, &step); err != nil || path != "diy" || step != "backup" {
		t.Fatalf("backfilled row = %q/%q, %v", path, step, err)
	}
}

func TestUnregisterThenRebindClearsPreviousOwnersProgress(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	owner := registerAccount(t, acctH, "unregowner@b.co")
	verifyEmailFor(t, acctH, "unregowner@b.co")
	other := registerAccount(t, acctH, "unregother@b.co")
	verifyEmailFor(t, acctH, "unregother@b.co")
	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(owner)
	if rec := withVerifiedAccount(acctH, devH.Bind, bindReq); rec.Code != http.StatusOK {
		t.Fatalf("first bind %d", rec.Code)
	}
	_, _ = d.DB.Exec(`UPDATE device_onboarding SET step = 'backup' WHERE device_id = ?`, devID)

	unbindDevice(d, Device{ID: devID, AccountID: sql.NullString{String: accountIDFor(t, d, "unregowner@b.co"), Valid: true}}, accountIDFor(t, d, "unregowner@b.co"))
	var gone int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM device_onboarding WHERE device_id = ?`, devID).Scan(&gone)
	if gone != 0 {
		t.Fatalf("unregister left progress behind")
	}

	rebindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	rebindReq.AddCookie(other)
	if rec := withVerifiedAccount(acctH, devH.Bind, rebindReq); rec.Code != http.StatusOK {
		t.Fatalf("rebind %d %s", rec.Code, rec.Body.String())
	}
	var ownerID string
	_ = d.DB.QueryRow(`SELECT account_id FROM device_onboarding WHERE device_id = ?`, devID).Scan(&ownerID)
	if ownerID != accountIDFor(t, d, "unregother@b.co") {
		t.Fatalf("progress still owned by %q", ownerID)
	}
	var step string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, devID).Scan(&step)
	if step != "domain" {
		t.Fatalf("rebound Luna resumed at %q", step)
	}
}

func TestProgressWriteCannotFollowARebindRace(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	owner := registerAccount(t, acctH, "raceowner@b.co")
	verifyEmailFor(t, acctH, "raceowner@b.co")
	registerAccount(t, acctH, "raceother@b.co")
	verifyEmailFor(t, acctH, "raceother@b.co")
	devID := bindMintedLuna(t, d, acctH, devH, owner)

	saveDeviceOnboarding(d.DB, devID, accountIDFor(t, d, "raceother@b.co"), "official", "done")
	var accountID, step string
	if err := d.DB.QueryRow(`SELECT account_id, step FROM device_onboarding WHERE device_id = ?`, devID).Scan(&accountID, &step); err != nil {
		t.Fatalf("progress row: %v", err)
	}
	if accountID != accountIDFor(t, d, "raceowner@b.co") || step != "domain" {
		t.Fatalf("foreign write changed progress to %q/%q", accountID, step)
	}
}

func TestCheckoutMirrorDoesNotClosePerLunaProgress(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "pay@b.co")
	verifyEmailFor(t, acctH, "pay@b.co")
	first := bindMintedLuna(t, d, acctH, devH, cookie)
	second := bindMintedLuna(t, d, acctH, devH, cookie)
	_, _ = d.DB.Exec(`UPDATE device_onboarding SET step = 'backup' WHERE device_id = ?`, first)

	finishOnboardingForAccount(d.DB, accountIDFor(t, d, "pay@b.co"))
	var steps [2]string
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, first).Scan(&steps[0])
	_ = d.DB.QueryRow(`SELECT step FROM device_onboarding WHERE device_id = ?`, second).Scan(&steps[1])
	if steps[0] != "backup" || steps[1] != "domain" {
		t.Fatalf("checkout changed per-Luna steps: %v", steps)
	}
	var mirror string
	_ = d.DB.QueryRow(`SELECT onboarding_step FROM accounts WHERE email = ?`, "pay@b.co").Scan(&mirror)
	if mirror != "done" {
		t.Fatalf("account mirror = %q", mirror)
	}
	onbH := OnboardingHandler{Deps: d}
	req := httptest.NewRequest(http.MethodGet, "/onboarding/status", nil)
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, onbH.Status, req)
	var status map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &status)
	if status["step"] != "done" {
		t.Fatalf("account-wide status after checkout = %v, want done", status["step"])
	}
}

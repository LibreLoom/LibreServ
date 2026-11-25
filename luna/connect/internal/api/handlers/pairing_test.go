package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func startPairRequest(t *testing.T, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, uid, code string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: code})
	req := httptest.NewRequest(http.MethodPost, "/devices/pair", bytes.NewReader(body))
	req.AddCookie(cookie)
	return withVerifiedAccount(acctH, devH.StartPair, req)
}

func differentVerificationCode(code string) string {
	if code == "000000" {
		return "FFFFFF"
	}
	return "000000"
}

func claimPairRequest(devH DeviceHandler, uid, code string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: code})
	rec := httptest.NewRecorder()
	devH.ClaimPair(rec, httptest.NewRequest(http.MethodPost, "/devices/pair/claim", bytes.NewReader(body)))
	return rec
}

func pairingStatusRequest(t *testing.T, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, pairingID string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/devices/pair/"+pairingID, nil)
	req.AddCookie(cookie)
	req = withChiParam(req, "pairingID", pairingID)
	return withVerifiedAccount(acctH, devH.PairStatus, req)
}

func TestPairingStateTransitionsExpiryCancellationAndFirstClaim(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie1 := registerAccount(t, acctH, "pair-one@b.co")
	cookie2 := registerAccount(t, acctH, "pair-two@b.co")
	verifyEmailFor(t, acctH, "pair-one@b.co")
	verifyEmailFor(t, acctH, "pair-two@b.co")
	devID, uid, code := mintDevice(t, d, "official")

	start1 := startPairRequest(t, acctH, devH, cookie1, uid, code)
	if start1.Code != http.StatusOK {
		t.Fatalf("start one %d %s", start1.Code, start1.Body.String())
	}
	var started map[string]any
	_ = json.Unmarshal(start1.Body.Bytes(), &started)
	pairingID := started["pairing_id"].(string)
	if again := startPairRequest(t, acctH, devH, cookie1, uid, code); again.Code != http.StatusOK || !strings.Contains(again.Body.String(), pairingID) {
		t.Fatalf("same-account retry must retain live attempt: %d %s", again.Code, again.Body.String())
	}
	if other := startPairRequest(t, acctH, devH, cookie2, uid, code); other.Code != http.StatusBadRequest {
		t.Fatalf("live attempt displaced for another account: %d %s", other.Code, other.Body.String())
	}
	if status := pairingStatusRequest(t, acctH, devH, cookie1, pairingID); status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"waiting"`) {
		t.Fatalf("waiting status %d %s", status.Code, status.Body.String())
	}

	_, _ = d.DB.Exec(`UPDATE device_pairings SET expires_at = ? WHERE id = ?`, time.Now().Unix()-1, pairingID)
	if status := pairingStatusRequest(t, acctH, devH, cookie1, pairingID); status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"unbound"`) {
		t.Fatalf("expired status %d %s", status.Code, status.Body.String())
	}
	var state string
	var account sql.NullString
	_ = d.DB.QueryRow(`SELECT state, account_id FROM devices WHERE id = ?`, devID).Scan(&state, &account)
	if state != "unbound" || account.Valid {
		t.Fatalf("expired attempt did not return to unbound: state=%s account=%v", state, account)
	}

	start2 := startPairRequest(t, acctH, devH, cookie2, uid, code)
	if start2.Code != http.StatusOK {
		t.Fatalf("replacement start %d %s", start2.Code, start2.Body.String())
	}
	_ = json.Unmarshal(start2.Body.Bytes(), &started)
	pairingID = started["pairing_id"].(string)
	cancelReq := httptest.NewRequest(http.MethodDelete, "/devices/pair/"+pairingID, nil)
	cancelReq.AddCookie(cookie2)
	cancelReq = withChiParam(cancelReq, "pairingID", pairingID)
	cancelRec := withVerifiedAccount(acctH, devH.CancelPair, cancelReq)
	if cancelRec.Code != http.StatusOK {
		t.Fatalf("cancel %d %s", cancelRec.Code, cancelRec.Body.String())
	}
	if rec := claimPairRequest(devH, uid, code); rec.Code != http.StatusNotFound {
		t.Fatalf("cancelled attempt claimed: %d %s", rec.Code, rec.Body.String())
	}

	start3 := startPairRequest(t, acctH, devH, cookie1, uid, code)
	if start3.Code != http.StatusOK {
		t.Fatalf("final start %d %s", start3.Code, start3.Body.String())
	}
	_ = json.Unmarshal(start3.Body.Bytes(), &started)
	pairingID = started["pairing_id"].(string)
	claim := claimPairRequest(devH, uid, code)
	if claim.Code != http.StatusOK {
		t.Fatalf("first claim %d %s", claim.Code, claim.Body.String())
	}
	if replay := claimPairRequest(devH, uid, code); replay.Code != http.StatusNotFound {
		t.Fatalf("second claim %d %s", replay.Code, replay.Body.String())
	}
	if status := pairingStatusRequest(t, acctH, devH, cookie1, pairingID); status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"bound"`) || !strings.Contains(status.Body.String(), devID) {
		t.Fatalf("claimed pairing status: %d %s", status.Code, status.Body.String())
	}
}

func TestPairingErrorsAreGeneric(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "generic@b.co")
	verifyEmailFor(t, acctH, "generic@b.co")
	_, uid, actualCode := mintDevice(t, d, "official")

	unknown := startPairRequest(t, acctH, devH, cookie, security.DeviceUID(), "A3F91C")
	wrong := startPairRequest(t, acctH, devH, cookie, uid, differentVerificationCode(actualCode))
	if unknown.Code != http.StatusBadRequest || wrong.Code != unknown.Code || unknown.Body.String() != wrong.Body.String() {
		t.Fatalf("pairing errors differ: unknown=%d %s wrong=%d %s", unknown.Code, unknown.Body.String(), wrong.Code, wrong.Body.String())
	}
	if strings.Contains(unknown.Body.String(), "not found") || strings.Contains(unknown.Body.String(), uid) {
		t.Fatalf("generic error leaked device existence: %s", unknown.Body.String())
	}
}

func TestClaimPairRepeatedNoAttemptPollingDoesNotCountAsFailure(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	_, uid, code := mintDevice(t, d, "official")

	for i := 0; i < pairingDeviceFailures*2+1; i++ {
		rec := claimPairRequest(devH, uid, code)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("no-attempt poll %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	ip := ClientIP(httptest.NewRequest(http.MethodPost, "/devices/pair/claim", nil))
	var failures int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM guess_attempts WHERE key IN (?, ?)`,
		"pair-device:"+uid, "pair-ip:"+ip).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 0 {
		t.Fatalf("ordinary no-attempt polling recorded %d failures", failures)
	}

	cookie := registerAccount(t, acctH, "no-attempt@b.co")
	verifyEmailFor(t, acctH, "no-attempt@b.co")
	_, _ = pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
}

func TestClaimPairInvalidCodeIsGenericAndThrottled(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	_, uid, code := mintDevice(t, d, "official")

	noAttempt := claimPairRequest(devH, uid, code)
	if noAttempt.Code != http.StatusNotFound {
		t.Fatalf("no-attempt response %d %s", noAttempt.Code, noAttempt.Body.String())
	}
	wrongCode := differentVerificationCode(code)
	for i := 0; i < pairingDeviceFailures; i++ {
		rec := claimPairRequest(devH, uid, wrongCode)
		if rec.Code != http.StatusNotFound || rec.Body.String() != noAttempt.Body.String() {
			t.Fatalf("invalid-code response %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := claimPairRequest(devH, uid, wrongCode); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("invalid code was not throttled: %d %s", rec.Code, rec.Body.String())
	}
	var failures int
	if err := d.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, "pair-device:"+uid).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != pairingDeviceFailures {
		t.Fatalf("invalid-code failures=%d, want %d", failures, pairingDeviceFailures)
	}
}

func TestPairingDeviceLimitAndTrustedIPRelaxation(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	_, uid, actualCode := mintDevice(t, d, "official")
	wrongCode := differentVerificationCode(actualCode)
	now := time.Now().Unix()
	const trustedIP = "203.0.113.77"
	_, _ = d.DB.Exec(`UPDATE devices SET last_public_ip = ?, last_public_ip_at = ? WHERE device_uid = ?`, trustedIP, now, uid)

	claimWrong := func(remote, cf string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: wrongCode})
		req := httptest.NewRequest(http.MethodPost, "/devices/pair/claim", bytes.NewReader(body))
		req.RemoteAddr = remote
		if cf != "" {
			req.Header.Set("CF-Connecting-IP", cf)
		}
		rec := httptest.NewRecorder()
		devH.ClaimPair(rec, req)
		return rec
	}
	for i := 0; i < pairingDeviceFailures; i++ {
		if rec := claimWrong("198.51.100.10:1234", trustedIP); rec.Code != http.StatusNotFound {
			t.Fatalf("untrusted header trusted on failure %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	// Five failures fill the ordinary device bucket. A trusted proxy resolving
	// to the Luna's recent public IP raises that same bucket's limit to twenty.
	for i := pairingDeviceFailures; i < pairingDeviceIPFailures; i++ {
		if rec := claimWrong("127.0.0.1:1234", trustedIP); rec.Code != http.StatusNotFound {
			t.Fatalf("trusted-IP failure %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := claimWrong("127.0.0.1:1234", trustedIP); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over relaxed device limit: %d %s", rec.Code, rec.Body.String())
	}
	var count int
	if err := d.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, "pair-device:"+uid).Scan(&count); err != nil || count != pairingDeviceIPFailures {
		t.Fatalf("persisted device failures=%d err=%v", count, err)
	}
	var sequence int
	var databaseName, path string
	if err := d.DB.QueryRow(`PRAGMA database_list`).Scan(&sequence, &databaseName, &path); err != nil {
		t.Fatal(err)
	}
	_ = d.DB.Close()
	reopened, err := database.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if err := database.Migrate(reopened); err != nil {
		t.Fatal(err)
	}
	if err := reopened.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, "pair-device:"+uid).Scan(&count); err != nil || count != pairingDeviceIPFailures {
		t.Fatalf("device failures did not survive reopen: count=%d err=%v", count, err)
	}
}

func TestPairingAccountAndIPLimits(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "limits@b.co")
	verifyEmailFor(t, acctH, "limits@b.co")
	for i := 0; i < pairingAccountFailures; i++ {
		uid := security.DeviceUID()
		rec := startPairRequest(t, acctH, devH, cookie, uid, "A3F91C")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("account failure %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
		// Keep the shared IP bucket below its independent cap.
		_, _ = d.DB.Exec(`DELETE FROM guess_attempts WHERE key = ?`, "pair-ip:"+ClientIP(httptest.NewRequest(http.MethodPost, "/", nil)))
	}
	if rec := startPairRequest(t, acctH, devH, cookie, security.DeviceUID(), "A3F91C"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("account cap: %d %s", rec.Code, rec.Body.String())
	}

	for i := 0; i < pairingIPFailures; i++ {
		rec := claimPairRequest(devH, security.DeviceUID(), "A3F91C")
		if rec.Code != http.StatusNotFound {
			t.Fatalf("IP failure %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if rec := claimPairRequest(devH, security.DeviceUID(), "A3F91C"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("IP cap: %d %s", rec.Code, rec.Body.String())
	}
}

func TestPairingRequiresVerifiedAccount(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerUnverifiedAccount(t, acctH, "unverified@b.co")
	_, uid, code := mintDevice(t, d, "official")
	if rec := startPairRequest(t, acctH, devH, cookie, uid, code); rec.Code != http.StatusForbidden {
		t.Fatalf("unverified pair %d %s", rec.Code, rec.Body.String())
	}
}

func TestConcurrentInvalidClaimsCannotExceedDeviceFailureLimit(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	_, uid, code := mintDevice(t, d, "official")
	wrong := differentVerificationCode(code)
	const attempts = 24
	recs := make([]*httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range recs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			recs[i] = claimPairRequest(devH, uid, wrong)
		}(i)
	}
	close(start)
	wg.Wait()

	invalid, limited := 0, 0
	for i, rec := range recs {
		switch rec.Code {
		case http.StatusNotFound:
			invalid++
		case http.StatusTooManyRequests:
			limited++
		default:
			t.Fatalf("attempt %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if invalid != pairingDeviceFailures || limited != attempts-pairingDeviceFailures {
		t.Fatalf("invalid=%d limited=%d, want %d and %d", invalid, limited, pairingDeviceFailures, attempts-pairingDeviceFailures)
	}
	var count int
	if err := d.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, "pair-device:"+uid).Scan(&count); err != nil || count != pairingDeviceFailures {
		t.Fatalf("persisted failures=%d err=%v", count, err)
	}
}

func TestConcurrentStartPairInvalidGuessesCannotExceedDeviceFailureLimit(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "parallel-start@b.co")
	verifyEmailFor(t, acctH, "parallel-start@b.co")
	_, uid, code := mintDevice(t, d, "official")
	wrong := differentVerificationCode(code)
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: wrong})
	const attempts = 24
	recs := make([]*httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range recs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			req := httptest.NewRequest(http.MethodPost, "/devices/pair", bytes.NewReader(body))
			req.AddCookie(cookie)
			recs[i] = withVerifiedAccount(acctH, devH.StartPair, req)
		}(i)
	}
	close(start)
	wg.Wait()

	invalid, limited := 0, 0
	for i, rec := range recs {
		switch rec.Code {
		case http.StatusBadRequest:
			invalid++
		case http.StatusTooManyRequests:
			limited++
		default:
			t.Fatalf("attempt %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if invalid != pairingDeviceFailures || limited != attempts-pairingDeviceFailures {
		t.Fatalf("invalid=%d limited=%d, want %d and %d", invalid, limited, pairingDeviceFailures, attempts-pairingDeviceFailures)
	}
}

func TestConcurrentValidNoAttemptPollsAreAllRefunded(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	_, uid, code := mintDevice(t, d, "official")
	const attempts = 24
	recs := make([]*httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range recs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			recs[i] = claimPairRequest(devH, uid, code)
		}(i)
	}
	close(start)
	wg.Wait()
	for i, rec := range recs {
		if rec.Code != http.StatusNotFound {
			t.Fatalf("poll %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	var rows int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM guess_attempts WHERE key IN (?, ?)`,
		"pair-device:"+uid, "pair-ip:"+ClientIP(httptest.NewRequest(http.MethodPost, "/devices/pair/claim", nil))).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("valid no-attempt polls left %d rate-limit rows", rows)
	}
}

func TestConcurrentValidClaimsHaveOneWinner(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "parallel-claim@b.co")
	verifyEmailFor(t, acctH, "parallel-claim@b.co")
	_, uid, code := mintDevice(t, d, "official")
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: code})
	startReq := httptest.NewRequest(http.MethodPost, "/devices/pair", bytes.NewReader(body))
	startReq.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, devH.StartPair, startReq); rec.Code != http.StatusOK {
		t.Fatalf("start pair %d %s", rec.Code, rec.Body.String())
	}

	const attempts = 12
	recs := make([]*httptest.ResponseRecorder, attempts)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range recs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			recs[i] = claimPairRequest(devH, uid, code)
		}(i)
	}
	close(start)
	wg.Wait()
	winners := 0
	for i, rec := range recs {
		switch rec.Code {
		case http.StatusOK:
			winners++
		case http.StatusNotFound, http.StatusTooManyRequests:
		default:
			t.Fatalf("claim %d: %d %s", i+1, rec.Code, rec.Body.String())
		}
	}
	if winners != 1 {
		t.Fatalf("successful claims=%d, want 1", winners)
	}
}

func TestLockedPairingStatusAndCancelIgnoreStaleIDs(t *testing.T) {
	d := testDeps(t)
	insertBareAccount(t, d, "acct_pair_old")
	insertBareAccount(t, d, "acct_pair_new")
	devID, _, _ := mintDevice(t, d, "official")
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO device_pairings (id, device_id, account_id, created_at, expires_at)
VALUES ('pair_stale', ?, 'acct_pair_old', ?, ?)`, devID, now, now-1)
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'pairing', account_id = 'acct_pair_old' WHERE id = ?`, devID)
	_, _ = d.DB.Exec(`DELETE FROM device_pairings WHERE device_id = ?`, devID)
	_, _ = d.DB.Exec(`INSERT INTO device_pairings (id, device_id, account_id, created_at, expires_at)
VALUES ('pair_live', ?, 'acct_pair_new', ?, ?)`, devID, now, now+300)
	_, _ = d.DB.Exec(`UPDATE devices SET state = 'pairing', account_id = 'acct_pair_new' WHERE id = ?`, devID)

	tx, err := d.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.LockDevice(tx, devID); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	status, _, found, err := lockedPairingStatus(tx, devID, "pair_stale", "acct_pair_old", now)
	if err != nil || found {
		_ = tx.Rollback()
		t.Fatalf("stale status found=%v status=%q err=%v", found, status, err)
	}
	cancelled, err := lockedCancelPairing(tx, devID, "pair_stale", "acct_pair_old")
	if err != nil || cancelled {
		_ = tx.Rollback()
		t.Fatalf("stale cancel cancelled=%v err=%v", cancelled, err)
	}
	cancelled, err = lockedCancelPairing(tx, devID, "pair_live", "acct_pair_old")
	if err != nil || cancelled {
		_ = tx.Rollback()
		t.Fatalf("wrong-account cancel cancelled=%v err=%v", cancelled, err)
	}
	status, _, found, err = lockedPairingStatus(tx, devID, "pair_live", "acct_pair_new", now)
	if err != nil || !found || status != "waiting" {
		_ = tx.Rollback()
		t.Fatalf("replacement status found=%v status=%q err=%v", found, status, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	var state, account, pairingID string
	if err := d.DB.QueryRow(`SELECT state, account_id FROM devices WHERE id = ?`, devID).Scan(&state, &account); err != nil {
		t.Fatal(err)
	}
	if err := d.DB.QueryRow(`SELECT id FROM device_pairings WHERE device_id = ?`, devID).Scan(&pairingID); err != nil {
		t.Fatal(err)
	}
	if state != "pairing" || account != "acct_pair_new" || pairingID != "pair_live" {
		t.Fatalf("stale request changed replacement: state=%s account=%s pairing=%s", state, account, pairingID)
	}
}

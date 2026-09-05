package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type OnboardingHandler struct {
	Deps
}

func (h OnboardingHandler) Backups(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Enable          bool   `json:"enable"`
		PaymentMethod   string `json:"payment_method"`
		PaymentMethodID string `json:"payment_method_id"`
		DeviceID        string `json:"device_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if !req.Enable {
		_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = 'done' WHERE id = ?`, acct.ID)
		JSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": false})
		return
	}
	pm := strings.TrimSpace(req.PaymentMethod)
	if pm == "" {
		pm = strings.TrimSpace(req.PaymentMethodID)
	}
	cust, err := billing.EnsureCustomer(acct.Email, acct.StripeCustomer)
	if err != nil {
		writeBillingErr(w, err, "Could not start cloud backup. Check the card and try again.")
		return
	}
	if cust != acct.StripeCustomer {
		_, _ = h.DB.Exec(`UPDATE accounts SET stripe_customer_id = ? WHERE id = ?`, cust, acct.ID)
		acct.StripeCustomer = cust
	}
	sub, item, err := billing.Subscribe(cust, pm)
	if err != nil {
		writeBillingErr(w, err, "Could not start cloud backup. Check the card and try again.")
		return
	}
	status := "active"
	price := "Cloud backup costs $8 per terabyte each month, based on your average storage. Downloads are free up to 3× stored amount."
	if billing.DevBypass() {
		status = "dev"
		price = "Cloud backup costs $8 per terabyte each month. Luna will turn cloud backup on when it is next quiet."
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = ?, stripe_subscription_id = ?, stripe_subscription_item_id = ?, backup_purge_after = NULL, purge_mail_day = NULL, onboarding_step = 'done' WHERE id = ?`,
		status, sub, item, acct.ID)
	if req.DeviceID != "" {
		h.ensureBackupBinding(acct.ID, req.DeviceID)
	} else {
		var devID string
		if err := h.DB.QueryRow(`SELECT id FROM devices WHERE account_id = ? LIMIT 1`, acct.ID).Scan(&devID); err == nil {
			h.ensureBackupBinding(acct.ID, devID)
		}
	}
	JSON(w, http.StatusOK, map[string]any{
		"ok": true, "enabled": true,
		"price_copy": price,
	})
}

func (h OnboardingHandler) ensureBackupBinding(accountID, deviceID string) {
	id := security.NewID("bb")
	_, _ = h.DB.Exec(`INSERT INTO backup_bindings (id, account_id, device_id, status, created_at)
VALUES (?, ?, ?, 'active', ?)
ON CONFLICT(account_id, device_id) DO UPDATE SET status = 'active', archived_at = NULL, archive_key = NULL`,
		id, accountID, deviceID, time.Now().Unix())
}

func (h OnboardingHandler) VerifyHuman(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Create a Luna Connect account first.")
		return
	}
	okMsg := "A one-time $1 charge checks that your card works. It counts toward cloud backup if you turn that on."
	var existing string
	err := h.DB.QueryRow(`SELECT payment_intent_id FROM oss_payments WHERE account_id = ? AND status = 'succeeded'`, acct.ID).Scan(&existing)
	if err == nil && existing != "" {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "message": okMsg})
		return
	}
	var req struct {
		PaymentMethod   string `json:"payment_method"`
		PaymentMethodID string `json:"payment_method_id"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	pm := strings.TrimSpace(req.PaymentMethod)
	if pm == "" {
		pm = strings.TrimSpace(req.PaymentMethodID)
	}
	cust, err := billing.EnsureCustomer(acct.Email, acct.StripeCustomer)
	if err != nil {
		if errors.Is(err, billing.ErrNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Card checks are not available right now. Try again later, or contact support to resolve this issue.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Could not set up card billing for this account. Try again in a few minutes.")
		return
	}
	if cust != acct.StripeCustomer {
		_, _ = h.DB.Exec(`UPDATE accounts SET stripe_customer_id = ? WHERE id = ?`, cust, acct.ID)
		acct.StripeCustomer = cust
	}
	pi, err := billing.ChargeOneDollar(cust, pm)
	if err != nil {
		if errors.Is(err, billing.ErrPaymentMethodRequired) {
			JSONError(w, http.StatusBadRequest, "Add a card on this page first, then try again.")
			return
		}
		if errors.Is(err, billing.ErrNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Card checks are not available right now. Try again later, or contact support to resolve this issue.")
			return
		}
		JSONError(w, http.StatusBadRequest, "The $1 card check failed. Check the card and try again.")
		return
	}
	_, _ = h.DB.Exec(`INSERT INTO oss_payments (account_id, payment_intent_id, status, created_at) VALUES (?, ?, 'succeeded', ?)
ON CONFLICT(account_id) DO UPDATE SET payment_intent_id=excluded.payment_intent_id, status='succeeded'`,
		acct.ID, pi, time.Now().Unix())
	JSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"message": okMsg,
	})
}

// MintDIY creates a permanent unbound DIY device code after the $1 human check.
func (h OnboardingHandler) MintDIY(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var payStatus string
	if err := h.DB.QueryRow(`SELECT status FROM oss_payments WHERE account_id = ?`, acct.ID).Scan(&payStatus); err != nil || payStatus != "succeeded" {
		if !billing.DevBypass() {
			JSONError(w, http.StatusForbidden, "Add and confirm your card with the $1 check first.")
			return
		}
	}
	if !allowGuess(h.DB, "diy-mint:"+acct.ID, 5, 3600) {
		JSONError(w, http.StatusTooManyRequests, "Too many device tokens on this account. Wait an hour, then try again.")
		return
	}
	id, code, err := insertPermanentDevice(h.DB, "diy", security.OfficialDeviceToken(), "")
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create a device token. Try again.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_path = 'diy', onboarding_step = 'diy-code' WHERE id = ?`, acct.ID)
	JSON(w, http.StatusCreated, map[string]any{
		"device_id": id,
		"code":      code,
		"message":   "Put this full code on Luna during install (paste when the installer asks after the disk is written), or later in Settings → About → Advanced → Device token. The first eight characters unlock setup from your phone.",
	})
}

func (h OnboardingHandler) AdminMint(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OrderRef string `json:"order_ref"`
		Count    int    `json:"count"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Count <= 0 {
		req.Count = 1
	}
	if req.Count > 100 {
		req.Count = 100
	}
	type minted struct {
		ID   string `json:"id"`
		Code string `json:"code"`
	}
	out := make([]minted, 0, req.Count)
	for i := 0; i < req.Count; i++ {
		id, code, err := insertPermanentDevice(h.DB, "official", security.OfficialDeviceToken(), req.OrderRef)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not create a device token. Try again.")
			return
		}
		out = append(out, minted{ID: id, Code: code})
	}
	if len(out) == 1 {
		JSON(w, http.StatusCreated, map[string]any{
			"id": out[0].ID, "code": out[0].Code,
			"message": "Print this on the quick-start card. First eight characters unlock phone setup; full code binds Connect.",
		})
		return
	}
	JSON(w, http.StatusCreated, map[string]any{"codes": out})
}

func (h OnboardingHandler) AdminMintBulk(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Count    int    `json:"count"`
		OrderRef string `json:"order_ref"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Count <= 0 {
		req.Count = 1
	}
	if req.Count > 500 {
		JSONError(w, http.StatusBadRequest, "Ask for at most 500 codes at a time.")
		return
	}
	var lines []string
	for i := 0; i < req.Count; i++ {
		_, code, err := insertPermanentDevice(h.DB, "official", security.OfficialDeviceToken(), req.OrderRef)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not create device tokens. Try again.")
			return
		}
		lines = append(lines, code)
	}
	JSON(w, http.StatusCreated, map[string]any{
		"filename": "TOKENS",
		"tokens":   lines,
		"count":    len(lines),
		"message":  "One device token per line. First eight characters unlock phone setup; full token links Luna Connect.",
	})
}

func (h OnboardingHandler) Status(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	dev := loadBoundDevice(h.DB, acct.ID)
	resolvedPath, resolvedStep := ResolveOnboarding(acct.OnboardingPath, acct.OnboardingStep, dev)
	persistOnboardingIfChanged(h.DB, acct.ID, acct.OnboardingPath, acct.OnboardingStep, resolvedPath, resolvedStep)
	JSON(w, http.StatusOK, onboardingStatusFields(resolvedPath, resolvedStep, dev))
}

func (h OnboardingHandler) SetOnboardingProgress(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var req struct {
		Path string `json:"path"`
		Step string `json:"step"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	path := strings.TrimSpace(req.Path)
	step := strings.TrimSpace(req.Step)
	if path != "" && path != "official" && path != "diy" {
		JSONError(w, http.StatusBadRequest, "Unknown setup path.")
		return
	}
	if step == "name" {
		step = "domain"
	}
	if step == "copies" {
		step = "backup"
	}
	storedPath := acct.OnboardingPath
	if path != "" {
		storedPath = path
	}
	dev := loadBoundDevice(h.DB, acct.ID)
	if dev.HasBound && isOnboardingCodeStep(step) {
		_, step = ResolveOnboarding(storedPath, step, dev)
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_path = COALESCE(NULLIF(?, ''), onboarding_path), onboarding_step = COALESCE(NULLIF(?, ''), onboarding_step) WHERE id = ?`,
		path, step, acct.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "path": storedPath, "step": step})
}

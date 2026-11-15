package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type OnboardingHandler struct {
	Deps
}

// Backups skips the optional cloud backup step. Turning backup on goes
// through StartCheckout (kind "backup"), which finishes onboarding once paid.
func (h OnboardingHandler) Backups(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	_, _ = h.DB.Exec(`UPDATE accounts SET onboarding_step = 'done' WHERE id = ?`, acct.ID)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": false})
}

// MintDIY creates a permanent unbound DIY device token after the $1 human check.
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
		"message":   "Paste this device token when the Luna installer asks for it. You can also add it later in Settings → About → Advanced on Luna.",
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
			"message": "Print this device token on the quick-start card. The full token links Luna to Luna Connect.",
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
		JSONError(w, http.StatusBadRequest, "Ask for 500 device tokens or fewer at a time.")
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
		"message":  "One device token per line. Each full token links one Luna to Luna Connect.",
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

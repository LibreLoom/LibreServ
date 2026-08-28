package handlers

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type AdminAuthHandler struct {
	Deps
}

func (h AdminAuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Email and password are required.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !allowGuess(h.DB, "admin-login:"+ClientIP(r), 10, 60) {
		JSONError(w, http.StatusTooManyRequests, "Too many sign-in tries from this network. Wait a minute, then try again.")
		return
	}

	var id, hash string
	var name sql.NullString
	var totpSecret sql.NullString
	var totpEnabled, isActive int
	err := h.DB.QueryRow(
		`SELECT id, password_hash, name, totp_secret, totp_enabled, is_active FROM admin_accounts WHERE email = ?`,
		email).Scan(&id, &hash, &name, &totpSecret, &totpEnabled, &isActive)
	if err == sql.ErrNoRows || auth.VerifyPassword(hash, req.Password) != nil {
		JSONError(w, http.StatusUnauthorized, "That email or password did not match.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not sign in. Try again.")
		return
	}
	if isActive != 1 {
		JSONError(w, http.StatusForbidden, "This admin account is disabled.")
		return
	}
	if totpEnabled == 1 && totpSecret.Valid && totpSecret.String != "" {
		if strings.TrimSpace(req.TOTPCode) == "" {
			JSON(w, http.StatusOK, map[string]any{
				"requires_2fa": true,
				"message":      "Enter your authenticator code to continue.",
			})
			return
		}
		if !auth.VerifyTOTP(totpSecret.String, strings.TrimSpace(req.TOTPCode)) {
			JSONError(w, http.StatusUnauthorized, "That authenticator code did not match.")
			return
		}
	}

	token, err := CreateAdminSession(h.DB, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not start an admin session. Try again.")
		return
	}
	displayName := ""
	if name.Valid {
		displayName = name.String
	}
	JSON(w, http.StatusOK, map[string]any{
		"token":   token,
		"id":      id,
		"email":   email,
		"name":    displayName,
		"has_2fa": totpEnabled == 1,
	})
}

func (h AdminAuthHandler) Seed(w http.ResponseWriter, r *http.Request) {
	seedToken := config.C.Auth.AdminSeedToken
	if seedToken == "" {
		if !IsLocalRequest(r) {
			JSONError(w, http.StatusForbidden, "Creating the first admin is only allowed from this machine. Set auth.admin_seed_token to seed remotely.")
			return
		}
	} else if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Seed-Token")), []byte(seedToken)) != 1 {
		JSONError(w, http.StatusForbidden, "Invalid or missing seed token.")
		return
	}

	var count int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM admin_accounts`).Scan(&count)
	if count > 0 {
		JSONError(w, http.StatusForbidden, "An admin account already exists. Sign in instead.")
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Email and password are required.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !auth.ValidEmail(email) {
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		JSONError(w, http.StatusBadRequest, "Passwords need at least 12 characters, with at least one letter and one number.")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create the admin account. Try again.")
		return
	}
	now := time.Now().Unix()
	adminID := security.NewID("admin")
	res, err := h.DB.Exec(
		`INSERT INTO admin_accounts (id, email, password_hash, name, created_at, updated_at)
		 SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin_accounts)`,
		adminID, email, hash, strings.TrimSpace(req.Name), now, now)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create the admin account. Try again.")
		return
	}
	if rows, _ := res.RowsAffected(); rows == 0 {
		JSONError(w, http.StatusForbidden, "An admin account already exists. Sign in instead.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"message": "Admin account created. Sign in to continue.",
		"id":      adminID,
	})
}

func (h AdminAuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	adminID := AdminIDFrom(r.Context())
	if adminID == "" || adminID == "static-admin" {
		JSON(w, http.StatusOK, map[string]any{
			"id":      adminID,
			"email":   "",
			"name":    "",
			"has_2fa": false,
			"static":  adminID == "static-admin",
		})
		return
	}
	var email string
	var name sql.NullString
	var totpEnabled int
	err := h.DB.QueryRow(`SELECT email, name, totp_enabled FROM admin_accounts WHERE id = ?`, adminID).
		Scan(&email, &name, &totpEnabled)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
		return
	}
	displayName := ""
	if name.Valid {
		displayName = name.String
	}
	JSON(w, http.StatusOK, map[string]any{
		"id":      adminID,
		"email":   email,
		"name":    displayName,
		"has_2fa": totpEnabled == 1,
		"static":  false,
	})
}

func (h AdminAuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	token := security.BearerToken(r.Header.Get("Authorization"))
	if token != "" {
		_, _ = h.DB.Exec(`DELETE FROM admin_sessions WHERE token_hash = ?`, security.HashToken(token))
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h AdminAuthHandler) Setup2FA(w http.ResponseWriter, r *http.Request) {
	adminID := AdminIDFrom(r.Context())
	if adminID == "" || adminID == "static-admin" {
		JSONError(w, http.StatusForbidden, "Sign in with an admin account to set up two-factor authentication.")
		return
	}
	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create an authenticator secret. Try again.")
		return
	}
	var email string
	_ = h.DB.QueryRow(`SELECT email FROM admin_accounts WHERE id = ?`, adminID).Scan(&email)
	uri := auth.TOTPURI(secret, email, "Luna Connect Admin")
	_, err = h.DB.Exec(`UPDATE admin_accounts SET totp_secret = ?, updated_at = ? WHERE id = ?`, secret, time.Now().Unix(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not save the authenticator secret. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"secret": secret, "uri": uri})
}

func (h AdminAuthHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	adminID := AdminIDFrom(r.Context())
	if adminID == "" || adminID == "static-admin" {
		JSONError(w, http.StatusForbidden, "Sign in with an admin account to enable two-factor authentication.")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Code) == "" {
		JSONError(w, http.StatusBadRequest, "Enter the authenticator code.")
		return
	}
	var secret sql.NullString
	err := h.DB.QueryRow(`SELECT totp_secret FROM admin_accounts WHERE id = ?`, adminID).Scan(&secret)
	if err != nil || !secret.Valid || secret.String == "" {
		JSONError(w, http.StatusBadRequest, "Set up two-factor authentication first.")
		return
	}
	if !auth.VerifyTOTP(secret.String, strings.TrimSpace(req.Code)) {
		JSONError(w, http.StatusUnauthorized, "That authenticator code did not match.")
		return
	}
	_, err = h.DB.Exec(`UPDATE admin_accounts SET totp_enabled = 1, updated_at = ? WHERE id = ?`, time.Now().Unix(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not enable two-factor authentication. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"message": "Two-factor authentication is on."})
}

func (h AdminAuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	adminID := AdminIDFrom(r.Context())
	if adminID == "" || adminID == "static-admin" {
		JSONError(w, http.StatusForbidden, "Sign in with an admin account to change your password.")
		return
	}
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CurrentPassword == "" || req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "Current password and new password are required.")
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		JSONError(w, http.StatusBadRequest, "New passwords need at least 12 characters, with at least one letter and one number.")
		return
	}
	var hash string
	err := h.DB.QueryRow(`SELECT password_hash FROM admin_accounts WHERE id = ?`, adminID).Scan(&hash)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not verify your password. Try again.")
		return
	}
	if auth.VerifyPassword(hash, req.CurrentPassword) != nil {
		JSONError(w, http.StatusUnauthorized, "Current password is incorrect.")
		return
	}
	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not update the password. Try again.")
		return
	}
	_, err = h.DB.Exec(`UPDATE admin_accounts SET password_hash = ?, updated_at = ? WHERE id = ?`, newHash, time.Now().Unix(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not update the password. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"message": "Password updated."})
}

func (h AdminAuthHandler) ListAdmins(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`
SELECT id, email, name, totp_enabled, is_active, created_at
FROM admin_accounts ORDER BY created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list admin accounts.")
		return
	}
	defer rows.Close()
	admins := make([]map[string]any, 0)
	for rows.Next() {
		var id, email string
		var name sql.NullString
		var totpEnabled, isActive int
		var created int64
		if err := rows.Scan(&id, &email, &name, &totpEnabled, &isActive, &created); err != nil {
			JSONError(w, http.StatusInternalServerError, "Could not list admin accounts.")
			return
		}
		displayName := ""
		if name.Valid {
			displayName = name.String
		}
		admins = append(admins, map[string]any{
			"id":         id,
			"email":      email,
			"name":       displayName,
			"has_2fa":    totpEnabled == 1,
			"is_active":  isActive == 1,
			"created_at": created,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"admins": admins})
}

func (h AdminAuthHandler) CreateAdmin(w http.ResponseWriter, r *http.Request) {
	adminID := AdminIDFrom(r.Context())
	if adminID == "" || adminID == "static-admin" {
		JSONError(w, http.StatusForbidden, "Sign in with an admin account to add staff.")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Email) == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Email and password are required.")
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !auth.ValidEmail(email) {
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		JSONError(w, http.StatusBadRequest, "Passwords need at least 12 characters, with at least one letter and one number.")
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not create the admin account. Try again.")
		return
	}
	now := time.Now().Unix()
	newID := security.NewID("admin")
	_, err = h.DB.Exec(
		`INSERT INTO admin_accounts (id, email, password_hash, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		newID, email, hash, strings.TrimSpace(req.Name), now, now)
	if err != nil {
		JSONError(w, http.StatusConflict, "An admin with that email already exists.")
		return
	}
	JSON(w, http.StatusCreated, map[string]any{
		"message": "Admin account created.",
		"id":      newID,
		"email":   email,
	})
}

func (h AdminAuthHandler) DeleteAdmin(w http.ResponseWriter, r *http.Request) {
	targetID := strings.TrimSpace(chi.URLParam(r, "adminID"))
	if targetID == "" {
		JSONError(w, http.StatusBadRequest, "Admin id is required.")
		return
	}
	currentID := AdminIDFrom(r.Context())
	if currentID == "" || currentID == "static-admin" {
		JSONError(w, http.StatusForbidden, "Sign in with an admin account to manage staff.")
		return
	}
	if targetID == currentID {
		JSONError(w, http.StatusBadRequest, "You cannot deactivate your own account.")
		return
	}
	var activeCount int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM admin_accounts WHERE is_active = 1`).Scan(&activeCount)
	if activeCount <= 1 {
		JSONError(w, http.StatusBadRequest, "You cannot deactivate the last active admin account.")
		return
	}
	res, err := h.DB.Exec(`UPDATE admin_accounts SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1`, time.Now().Unix(), targetID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not deactivate that admin. Try again.")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		JSONError(w, http.StatusNotFound, "That admin account was not found or is already inactive.")
		return
	}
	_, _ = h.DB.Exec(`DELETE FROM admin_sessions WHERE admin_id = ?`, targetID)
	JSON(w, http.StatusOK, map[string]any{"message": "Admin account deactivated."})
}

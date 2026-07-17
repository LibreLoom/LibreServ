package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// AdminAuthHandler handles admin authentication.
type AdminAuthHandler struct {
	db *sql.DB
}

func NewAdminAuthHandler(db *sql.DB) *AdminAuthHandler {
	return &AdminAuthHandler{db: db}
}

// Login authenticates an admin with email/password (and TOTP if enabled).
func (h *AdminAuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}

	var account struct {
		ID           string
		PasswordHash string
		Name         sql.NullString
		TOTPSecret   sql.NullString
		TOTPEnabled  bool
		IsActive     bool
	}
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, password_hash, name, totp_secret, totp_enabled, is_active FROM admin_accounts WHERE email = ?`,
		req.Email).Scan(&account.ID, &account.PasswordHash, &account.Name, &account.TOTPSecret, &account.TOTPEnabled, &account.IsActive)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not authenticate")
		return
	}
	if !account.IsActive {
		JSONError(w, http.StatusForbidden, "account is disabled")
		return
	}

	if err := auth.VerifyPassword(account.PasswordHash, req.Password); err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	if account.TOTPEnabled && account.TOTPSecret.Valid {
		if req.TOTPCode == "" {
			JSON(w, http.StatusOK, map[string]any{
				"requires_2fa": true,
				"message":      "Enter your authenticator code to continue.",
			})
			return
		}
		if !auth.VerifyTOTP(account.TOTPSecret.String, req.TOTPCode) {
			JSONError(w, http.StatusUnauthorized, "invalid authenticator code")
			return
		}
	}

	token, err := middleware.CreateAdminSession(h.db, account.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	name := ""
	if account.Name.Valid {
		name = account.Name.String
	}

	JSON(w, http.StatusOK, map[string]any{
		"token":   token,
		"id":      account.ID,
		"email":   req.Email,
		"name":    name,
		"has_2fa": account.TOTPEnabled,
	})
}

// Setup2FA generates a TOTP secret for the admin.
func (h *AdminAuthHandler) Setup2FA(w http.ResponseWriter, r *http.Request) {
	adminID := middleware.GetAdminID(r.Context())

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate secret")
		return
	}

	var email string
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT email FROM admin_accounts WHERE id = ?", adminID).Scan(&email)

	uri := auth.TOTPURI(secret, email, "Connect Admin")

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET totp_secret = ? WHERE id = ?", secret, adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not save secret")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"secret": secret,
		"uri":    uri,
	})
}

// Verify2FA enables 2FA for the admin.
func (h *AdminAuthHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	adminID := middleware.GetAdminID(r.Context())

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		JSONError(w, http.StatusBadRequest, "code required")
		return
	}

	var secret sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		"SELECT totp_secret FROM admin_accounts WHERE id = ?", adminID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "set up 2FA first")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET totp_enabled = 1, updated_at = ? WHERE id = ?", time.Now(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not enable 2FA")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "2FA enabled"})
}

// SeedAdmin creates the first admin account (only if none exist).
func (h *AdminAuthHandler) SeedAdmin(w http.ResponseWriter, r *http.Request) {
	var count int
	_ = h.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM admin_accounts").Scan(&count)
	if count > 0 {
		JSONError(w, http.StatusForbidden, "admin accounts already exist. Use login instead.")
		return
	}

	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}
	if len(req.Password) < 12 {
		JSONError(w, http.StatusBadRequest, "admin password must be at least 12 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	adminID := security.GenerateID("admin")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO admin_accounts (id, email, password_hash, name) VALUES (?, ?, ?, ?)`,
		adminID, req.Email, hash, req.Name)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create admin account")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"message": "admin account created. Please sign in.",
		"id":      adminID,
	})
}

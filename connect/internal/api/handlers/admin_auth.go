package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
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
		`SELECT id, password_hash, name, totp_secret, totp_enabled, is_active FROM admin_accounts WHERE email = $1`,
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
		"SELECT email FROM admin_accounts WHERE id = $1", adminID).Scan(&email)

	uri := auth.TOTPURI(secret, email, "Connect Admin")

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET totp_secret = $1 WHERE id = $2", secret, adminID)
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
		"SELECT totp_secret FROM admin_accounts WHERE id = $1", adminID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "set up 2FA first")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET totp_enabled = TRUE, updated_at = $1 WHERE id = $2", time.Now(), adminID)
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
		`INSERT INTO admin_accounts (id, email, password_hash, name) VALUES ($1, $2, $3, $4)`,
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

// ChangePassword lets an admin update their own password.
func (h *AdminAuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	adminID := middleware.GetAdminID(r.Context())

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CurrentPassword == "" || req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "current password and new password are required")
		return
	}
	if len(req.NewPassword) < 12 {
		JSONError(w, http.StatusBadRequest, "new password must be at least 12 characters")
		return
	}

	var hash string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT password_hash FROM admin_accounts WHERE id = $1", adminID).Scan(&hash)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify password")
		return
	}

	if err := auth.VerifyPassword(hash, req.CurrentPassword); err != nil {
		JSONError(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}

	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET password_hash = $1, updated_at = $2 WHERE id = $3",
		newHash, time.Now(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not update password")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "password updated"})
}

// ListAdmins returns all admin accounts (without password hashes).
func (h *AdminAuthHandler) ListAdmins(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, email, name, totp_enabled, is_active, created_at
		 FROM admin_accounts ORDER BY created_at DESC`)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list admin accounts")
		return
	}
	defer rows.Close()

	var admins []map[string]any
	for rows.Next() {
		var id, email string
		var name sql.NullString
		var totpEnabled, isActive bool
		var createdAt time.Time
		if err := rows.Scan(&id, &email, &name, &totpEnabled, &isActive, &createdAt); err != nil {
			JSONError(w, http.StatusInternalServerError, "could not scan admin account")
			return
		}
		admins = append(admins, map[string]any{
			"id":         id,
			"email":      email,
			"name":       name.String,
			"has_2fa":    totpEnabled,
			"is_active":  isActive,
			"created_at": createdAt,
		})
	}
	if admins == nil {
		admins = []map[string]any{}
	}
	JSON(w, http.StatusOK, map[string]any{"admins": admins})
}

// CreateAdmin creates a new admin account (authenticated, unlike SeedAdmin).
func (h *AdminAuthHandler) CreateAdmin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password are required")
		return
	}
	if len(req.Password) < 12 {
		JSONError(w, http.StatusBadRequest, "password must be at least 12 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	adminID := security.GenerateID("admin")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO admin_accounts (id, email, password_hash, name) VALUES ($1, $2, $3, $4)`,
		adminID, req.Email, hash, req.Name)
	if err != nil {
		JSONError(w, http.StatusConflict, "an admin with this email already exists")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"message": "admin account created",
		"id":      adminID,
		"email":   req.Email,
	})
}

// DeleteAdmin deactivates an admin account (soft delete — preserves audit trail).
func (h *AdminAuthHandler) DeleteAdmin(w http.ResponseWriter, r *http.Request) {
	adminID := chi.URLParam(r, "adminID")
	if adminID == "" {
		JSONError(w, http.StatusBadRequest, "admin ID is required")
		return
	}

	// Prevent self-deletion
	currentID := middleware.GetAdminID(r.Context())
	if adminID == currentID {
		JSONError(w, http.StatusBadRequest, "you cannot delete your own account")
		return
	}

	var count int
	_ = h.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM admin_accounts WHERE is_active = TRUE").Scan(&count)
	if count <= 1 {
		JSONError(w, http.StatusBadRequest, "cannot delete the last active admin account")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		"UPDATE admin_accounts SET is_active = FALSE, updated_at = $1 WHERE id = $2",
		time.Now(), adminID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not deactivate admin account")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "admin account deactivated"})
}

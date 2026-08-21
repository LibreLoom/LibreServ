package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// LunaFreeHandler issues free Connect keys directly to Luna devices.
//
// Luna promises "no subscription, ever", so the device must never be sent to
// a checkout page or a portal. Each request creates a free-plan account with
// a device-owned identity and returns a ready-to-activate Connect key.
type LunaFreeHandler struct {
	db *sql.DB

	mu       sync.Mutex
	attempts map[string]freeWindow
}

type freeWindow struct {
	count int
	start time.Time
}

func NewLunaFreeHandler(db *sql.DB) *LunaFreeHandler {
	return &LunaFreeHandler{db: db, attempts: make(map[string]freeWindow)}
}

// Create issues a free key. Rate limited per client IP (10/hour) because
// every request creates database rows.
//
// TODO(luna-connect-rebuild): when Luna Connect is rebuilt as its own app,
// rate-limit using the real RemoteAddr (or a trusted hop's address), not a
// client-supplied X-Forwarded-For. Do not change this limiter as a product
// feature now.
func (h *LunaFreeHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !h.allow(clientIP(r)) {
		JSONError(w, http.StatusTooManyRequests, "Luna Connect free keys are limited to a few per hour. Try again later.")
		return
	}

	var req struct {
		DeviceName string `json:"device_name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	accountID := security.GenerateID("luna")
	email := accountID + "@free.luna.libreloom.org"
	password := randomToken(24)
	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create Luna account")
		return
	}
	connectKey := security.GenerateConnectKey()
	keyHash := hashToken(connectKey)
	keyID := security.GenerateID("lic")

	tx, err := h.db.Begin()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create Luna account")
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, name, plan_id, is_active)
 VALUES ($1, $2, $3, $4, 'free', TRUE)`,
		accountID, email, passwordHash, strings.TrimSpace(req.DeviceName),
	); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create Luna account")
		return
	}
	if _, err := tx.Exec(
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, subdomain, status)
 VALUES ($1, $2, $3, $4, 'free', NULL, 'unused')`,
		keyID, keyHash, connectKey[:8], accountID,
	); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create Luna Connect key")
		return
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create Luna Connect key")
		return
	}

	JSON(w, http.StatusCreated, map[string]any{
		"connect_key": connectKey,
		"key_id":      keyID,
		"plan_id":     "free",
		"message":     "Free forever. Enter this key on your Luna to activate Connect.",
	})
}

func (h *LunaFreeHandler) allow(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if h.attempts == nil {
		h.attempts = make(map[string]freeWindow)
	}
	w, ok := h.attempts[ip]
	if !ok || now.Sub(w.start) >= time.Hour {
		h.attempts[ip] = freeWindow{count: 1, start: now}
		return true
	}
	if w.count >= 10 {
		return false
	}
	w.count++
	h.attempts[ip] = w
	return true
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func randomToken(bytes int) string {
	buf := make([]byte, bytes)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().String()))
	}
	return hex.EncodeToString(buf)
}

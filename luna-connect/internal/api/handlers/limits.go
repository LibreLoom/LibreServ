package handlers

import (
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func allowGuess(db *sql.DB, key string, max int, windowSec int64) bool {
	now := time.Now().Unix()
	var count, start, last int64
	err := db.QueryRow(`SELECT count, start, last FROM guess_attempts WHERE key = ?`, key).Scan(&count, &start, &last)
	if err != nil {
		_, _ = db.Exec(`INSERT INTO guess_attempts (key, count, start, last) VALUES (?, 1, ?, ?)`, key, now, now)
		return true
	}
	if now-start >= windowSec {
		_, _ = db.Exec(`UPDATE guess_attempts SET count = 1, start = ?, last = ? WHERE key = ?`, now, now, key)
		return true
	}
	if count >= int64(max) {
		return false
	}
	delay := time.Duration(0)
	if count >= 3 {
		delay = 40 * time.Millisecond * time.Duration(count)
		time.Sleep(delay)
	}
	if count >= int64(max) {
		return false
	}
	_, _ = db.Exec(`UPDATE guess_attempts SET count = count + 1, last = ? WHERE key = ?`, now, key)
	return true
}

func cookieSessionID(r *http.Request) string {
	c, err := r.Cookie("luna_setup_session")
	if err != nil {
		return ""
	}
	return c.Value
}

// setupSessionID prefers the HttpOnly cookie. Query ?session= is only used when
// the cookie is missing so a query string cannot override a live setup cookie.
func setupSessionID(r *http.Request) string {
	if id := cookieSessionID(r); id != "" {
		return id
	}
	return strings.TrimSpace(r.URL.Query().Get("session"))
}

func setSetupSessionCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "luna_setup_session",
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(15 * 60),
	})
}

func clientKeyIP(r *http.Request) string {
	return "ip:" + ClientIP(r)
}

func clientKeyAccount(id string) string {
	return "acct:" + id
}

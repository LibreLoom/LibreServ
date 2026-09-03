package handlers

import (
	"context"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func allowGuess(db *database.DB, key string, max int, windowSec int64) bool {
	if db == nil || key == "" || max <= 0 {
		return false
	}
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return false
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return false
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, "ROLLBACK")
		}
	}()
	now := time.Now().Unix()
	var count, start, last int64
	err = conn.QueryRowContext(ctx, `SELECT count, start, last FROM guess_attempts WHERE key = ?`, key).Scan(&count, &start, &last)
	if err != nil {
		if _, err := conn.ExecContext(ctx, `INSERT INTO guess_attempts (key, count, start, last) VALUES (?, 1, ?, ?)`, key, now, now); err != nil {
			return false
		}
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return true
	}
	if now-start >= windowSec {
		if _, err := conn.ExecContext(ctx, `UPDATE guess_attempts SET count = 1, start = ?, last = ? WHERE key = ?`, now, now, key); err != nil {
			return false
		}
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return true
	}
	if count >= int64(max) {
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return false
	}
	res, err := conn.ExecContext(ctx, `UPDATE guess_attempts SET count = count + 1, last = ? WHERE key = ? AND count < ?`, now, key, max)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return false
	}
	committed = true
	return n == 1
}

// guessBlocked reports whether key is at/over max for the window without recording a try.
func guessBlocked(db *database.DB, key string, max int, windowSec int64) bool {
	if db == nil || key == "" || max <= 0 {
		return true
	}
	ctx := context.Background()
	var count, start int64
	err := db.QueryRowContext(ctx, `SELECT count, start FROM guess_attempts WHERE key = ?`, key).Scan(&count, &start)
	if err != nil {
		return false
	}
	if time.Now().Unix()-start >= windowSec {
		return false
	}
	return count >= int64(max)
}

func authAttemptKey(ip, email string) string {
	return "auth:" + strings.ToLower(strings.TrimSpace(ip)) + "\x1e" + strings.ToLower(strings.TrimSpace(email))
}

func allowAuthAttempt(db *database.DB, ip, email string, max int, windowSec int64) bool {
	if db == nil || max <= 0 {
		return false
	}
	key := authAttemptKey(ip, email)
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return false
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return false
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, "ROLLBACK")
		}
	}()
	now := time.Now().Unix()
	var count, start int64
	err = conn.QueryRowContext(ctx, `SELECT count, start FROM register_attempts WHERE ip = ?`, key).Scan(&count, &start)
	if err != nil {
		if _, err := conn.ExecContext(ctx, `INSERT INTO register_attempts (ip, count, start) VALUES (?, 1, ?)`, key, now); err != nil {
			return false
		}
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return true
	}
	if now-start >= windowSec {
		if _, err := conn.ExecContext(ctx, `UPDATE register_attempts SET count = 1, start = ? WHERE ip = ?`, now, key); err != nil {
			return false
		}
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return true
	}
	if count >= int64(max) {
		if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
			return false
		}
		committed = true
		return false
	}
	res, err := conn.ExecContext(ctx, `UPDATE register_attempts SET count = count + 1 WHERE ip = ? AND count < ? AND start = ?`, key, max, start)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return false
	}
	committed = true
	return n == 1
}

// authBlocked reports whether the IP+email auth bucket is exhausted without recording a try.
func authBlocked(db *database.DB, ip, email string, max int, windowSec int64) bool {
	if db == nil || max <= 0 {
		return true
	}
	key := authAttemptKey(ip, email)
	ctx := context.Background()
	var count, start int64
	err := db.QueryRowContext(ctx, `SELECT count, start FROM register_attempts WHERE ip = ?`, key).Scan(&count, &start)
	if err != nil {
		return false
	}
	if time.Now().Unix()-start >= windowSec {
		return false
	}
	return count >= int64(max)
}

func cookieSessionID(r *http.Request) string {
	c, err := r.Cookie("luna_setup_session")
	if err != nil {
		return ""
	}
	return c.Value
}

func setupSessionID(r *http.Request) string {
	return cookieSessionID(r)
}

func setSetupSessionCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "luna_setup_session",
		Value:    id,
		Path:     "/",
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(15 * 60),
	})
}

func clientKeyIP(r *http.Request) string {
	return "ip:" + ClientIP(r)
}

func clientKeyAccount(id string) string {
	return "acct:" + id
}

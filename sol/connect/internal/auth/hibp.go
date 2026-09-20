package auth

import (
	"context"
	"crypto/sha1" //nolint:gosec // SHA-1 is required by the HIBP range API; only a 5-char prefix is transmitted
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// BreachedPasswordMessage matches LibreServ's rejectBreachedPassword copy.
const BreachedPasswordMessage = "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password."

var (
	hibpMu       sync.Mutex
	hibpRangeURL = "https://api.pwnedpasswords.com/range/"
)

// SetHIBPRangeURL overrides the HIBP range endpoint (tests only).
func SetHIBPRangeURL(url string) {
	hibpMu.Lock()
	defer hibpMu.Unlock()
	hibpRangeURL = url
}

func currentHIBPRangeURL() string {
	hibpMu.Lock()
	defer hibpMu.Unlock()
	return hibpRangeURL
}

// CheckBreachedPassword reports whether pw appears in known data breaches
// (Have I Been Pwned). Only the first 5 hex chars of the SHA-1 hash are sent.
// On any API/network error it returns (false, err) so callers can fail open.
func CheckBreachedPassword(pw string) (bool, error) {
	sum := sha1.Sum([]byte(pw)) //nolint:gosec // see import comment
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	prefix, suffix := full[:5], full[5:]

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, currentHIBPRangeURL()+prefix, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "LibreServConnect")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("hibp range api returned %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}

	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, suffix+":") {
			return true, nil
		}
	}
	return false, nil
}

// RejectBreachedPassword returns BreachedPasswordMessage when pw appears in
// known data breaches. Fails open on HIBP errors. Returns "" when allowed.
func RejectBreachedPassword(pw string) string {
	breached, err := CheckBreachedPassword(pw)
	if err != nil {
		slog.Warn("HIBP breach check skipped", "error", err)
		return ""
	}
	if breached {
		return BreachedPasswordMessage
	}
	return ""
}

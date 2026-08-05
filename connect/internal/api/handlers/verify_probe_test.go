package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

// probeWithDevice runs a verify-probe request as the given device.
func probeWithDevice(t *testing.T, db *sql.DB, deviceID string, payload map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verify-probe", bytes.NewReader(body))
	// Simulate the DeviceAuth middleware having run.
	ctx := middleware.WithDeviceID(req.Context(), deviceID)
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	NewVerifyProbeHandler(db).Probe(w, req)
	return w
}

func TestVerifyProbeAuthRequired(t *testing.T) {
	db := database.OpenTestDB(t)
	body, _ := json.Marshal(map[string]any{"host": "203.0.113.10", "port": 443})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/verify-probe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewVerifyProbeHandler(db).Probe(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestVerifyProbeRejectsArbitraryTarget(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")

	// Arbitrary IP not owned by the device → 403 (the abuse guard).
	w := probeWithDevice(t, db, deviceID, map[string]any{"host": "203.0.113.10", "port": 443})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (arbitrary target blocked), body=%s", w.Code, w.Body.String())
	}

	// Arbitrary hostname → 403.
	w = probeWithDevice(t, db, deviceID, map[string]any{"host": "example.com", "port": 443})
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (arbitrary hostname blocked)", w.Code)
	}
}

func TestVerifyProbeOwnSubdomainAllowed(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")

	// Give the device a subdomain.
	if _, err := db.Exec(`UPDATE devices SET subdomain = $1 WHERE id = $2`, "test-device.free.servers.libreloom.org", deviceID); err != nil {
		t.Fatalf("set subdomain: %v", err)
	}

	// Own subdomain → allowed (probe runs; reachable=false for an unresolvable
	// name is fine — the guard is about the 403, not the probe result).
	w := probeWithDevice(t, db, deviceID, map[string]any{"host": "test-device.free.servers.libreloom.org", "port": 443})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (own domain allowed), body=%s", w.Code, w.Body.String())
	}
}

func TestVerifyProbeRejectsBlockedIP(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")

	// Private/link-local/CGNAT targets are always blocked even if "own".
	for _, host := range []string{"192.168.1.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "127.0.0.1", "::1"} {
		w := probeWithDevice(t, db, deviceID, map[string]any{"host": host, "port": 443})
		if w.Code != http.StatusForbidden {
			t.Errorf("host %s: status = %d, want 403", host, w.Code)
		}
	}
}

func TestVerifyProbeRateLimit(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := activateDevice(t, db, "free")
	if _, err := db.Exec(`UPDATE devices SET subdomain = $1 WHERE id = $2`, "rl.free.servers.libreloom.org", deviceID); err != nil {
		t.Fatalf("set subdomain: %v", err)
	}

	// First probe OK, immediate second → 429.
	w1 := probeWithDevice(t, db, deviceID, map[string]any{"host": "rl.free.servers.libreloom.org", "port": 443})
	if w1.Code != http.StatusOK {
		t.Fatalf("first probe status = %d, want 200", w1.Code)
	}
	w2 := probeWithDevice(t, db, deviceID, map[string]any{"host": "rl.free.servers.libreloom.org", "port": 443})
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second probe status = %d, want 429", w2.Code)
	}
}

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1",
		"169.254.169.254", "100.64.0.1", "::1", "fe80::1",
		"0.0.0.0",
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("bad test IP %q", s)
		}
		if !isBlockedIP(ip) {
			t.Errorf("isBlockedIP(%s) = false, want true", s)
		}
	}
	allowed := []string{"203.0.113.10", "8.8.8.8", "2606:4700:4700::1111"}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("bad test IP %q", s)
		}
		if isBlockedIP(ip) {
			t.Errorf("isBlockedIP(%s) = true, want false", s)
		}
	}
}

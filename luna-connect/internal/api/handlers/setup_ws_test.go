package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func setupWSServer(t *testing.T, onb OnboardingHandler) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestSetupWSUnknownStillDropped(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	srv := setupWSServer(t, onb)
	c := helloWS(t, srv, "DEAD00")
	defer c.Close()
	msg := readType(t, c, "error")
	if msg["message"] != "unknown" {
		t.Fatalf("want unknown, got %v", msg)
	}
}

func TestSetupWSClaimedHelloRejected(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	norm := security.NormalizeToken(token)
	_, _ = onb.DB.Exec(`UPDATE issued_tokens SET status = 'claimed' WHERE token_hash = ?`, security.HashToken(norm))
	srv := setupWSServer(t, onb)
	c := helloWS(t, srv, token)
	defer c.Close()
	msg := readType(t, c, "error")
	if msg["message"] != "unknown" {
		t.Fatalf("claimed hello must be consumed, got %v", msg)
	}
}

func TestSetupWSGuessLimiter(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	srv := setupWSServer(t, onb)
	for i := 0; i < 9; i++ {
		c := helloWS(t, srv, "FFFFF"+string(rune('0'+i)))
		msg := readType(t, c, "error")
		c.Close()
		if i < 8 {
			if msg["message"] != "unknown" {
				t.Fatalf("attempt %d want unknown, got %v", i, msg)
			}
			continue
		}
		text, _ := msg["message"].(string)
		if !strings.Contains(strings.ToLower(text), "too many") {
			t.Fatalf("attempt %d want throttle, got %v", i, msg)
		}
	}
}

func TestSetupWSOfficialTokenStillLimited(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	srv := setupWSServer(t, onb)
	for i := 0; i < 8; i++ {
		c := helloWS(t, srv, "DEAD0"+string(rune('0'+i)))
		readType(t, c, "error")
		c.Close()
	}
	token := mintOfficial(t, onb)
	c := helloWS(t, srv, token)
	defer c.Close()
	msg := readType(t, c, "error")
	text, _ := msg["message"].(string)
	if !strings.Contains(strings.ToLower(text), "too many") {
		t.Fatalf("official hello should still hit IP limiter, got %v", msg)
	}
}

func TestSetupWSSecondHelloRejectedUntilClose(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	srv := setupWSServer(t, onb)

	first := helloWS(t, srv, token)
	readType(t, first, "accepted")
	readType(t, first, "waiting_for_website")

	second := helloWS(t, srv, token)
	msg := readType(t, second, "error")
	second.Close()
	text, _ := msg["message"].(string)
	if !strings.Contains(strings.ToLower(text), "already") {
		t.Fatalf("second hello want already-connected, got %v", msg)
	}

	hash := security.HashToken(security.NormalizeToken(token))
	if live := onb.Hub.Live(hash); live == nil {
		t.Fatal("first socket should still be live")
	}

	first.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !onb.Hub.HasLive(hash) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if onb.Hub.HasLive(hash) {
		t.Fatal("hub still holds socket after close")
	}

	third := helloWS(t, srv, token)
	defer third.Close()
	readType(t, third, "accepted")
	readType(t, third, "waiting_for_website")
}

func TestSetupWSMalformedHelloCountsAsGuess(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	srv := setupWSServer(t, onb)
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/setup/ws"
	for i := 0; i < 8; i++ {
		c, _, err := websocket.DefaultDialer.Dial(u, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := c.WriteJSON(map[string]any{"type": "ping"}); err != nil {
			t.Fatal(err)
		}
		readType(t, c, "error")
		c.Close()
	}
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.WriteJSON(map[string]any{"type": "hello", "token": "DEAD00"}); err != nil {
		t.Fatal(err)
	}
	msg := readType(t, c, "error")
	text, _ := msg["message"].(string)
	if !strings.Contains(strings.ToLower(text), "too many") {
		t.Fatalf("malformed hellos should consume IP budget, got %v", msg)
	}
}

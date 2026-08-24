package setuphub

import (
	"errors"
	"testing"
)

func TestRegisterRejectsLiveDuplicate(t *testing.T) {
	h := New()
	first := NewSocket("tok-hash", "192.0.2.10", "anonymous", 8090)
	if err := h.Register(first); err != nil {
		t.Fatalf("first register: %v", err)
	}
	second := NewSocket("tok-hash", "198.51.100.8", "anonymous", 8090)
	if err := h.Register(second); !errors.Is(err, ErrAlreadyLive) {
		t.Fatalf("second register want ErrAlreadyLive, got %v", err)
	}
	if got := h.Live("tok-hash"); got != first {
		t.Fatal("live socket was replaced")
	}
	if first.Dead() {
		t.Fatal("existing socket was closed")
	}
	if h.unclaimedTotal != 1 {
		t.Fatalf("unclaimedTotal=%d", h.unclaimedTotal)
	}

	first.Close()
	third := NewSocket("tok-hash", "203.0.113.4", "anonymous", 8090)
	if err := h.Register(third); err != nil {
		t.Fatalf("register after close: %v", err)
	}
	if got := h.Live("tok-hash"); got != third {
		t.Fatal("expected new socket after the old one died")
	}
	if h.unclaimedTotal != 1 {
		t.Fatalf("unclaimedTotal after replace=%d", h.unclaimedTotal)
	}
}

package auth

import (
	"testing"
	"time"
)

func TestJWTGenerateAndValidate(t *testing.T) {
	mgr := NewJWTManager("secret", time.Minute, time.Hour)

	pair, err := mgr.GenerateTokenPair("uid-1", "alice", "admin")
	if err != nil {
		t.Fatalf("GenerateTokenPair: %v", err)
	}
	if pair.AccessToken == "" || pair.RefreshToken == "" {
		t.Fatalf("expected non-empty tokens")
	}

	claims, err := mgr.ValidateToken(pair.AccessToken)
	if err != nil {
		t.Fatalf("ValidateToken: %v", err)
	}
	if claims.UserID != "uid-1" || claims.Username != "alice" || claims.Role != "admin" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestJWTRefresh(t *testing.T) {
	mgr := NewJWTManager("secret", time.Minute, time.Hour)
	pair, err := mgr.GenerateTokenPair("uid-2", "bob", "user")
	if err != nil {
		t.Fatalf("GenerateTokenPair: %v", err)
	}

	newPair, err := mgr.RefreshTokens(pair.RefreshToken)
	if err != nil {
		t.Fatalf("RefreshTokens: %v", err)
	}
	if newPair.AccessToken == "" || newPair.RefreshToken == "" {
		t.Fatalf("expected refreshed tokens")
	}
}


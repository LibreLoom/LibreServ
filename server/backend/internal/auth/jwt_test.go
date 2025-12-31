package auth

import (
	"testing"
	"time"
)

func TestJWTGenerateValidate(t *testing.T) {
	j := NewJWTManager("secret", 15*time.Minute, 24*time.Hour)
	tokens, err := j.GenerateTokenPair("user1", "alice", "admin")
	if err != nil {
		t.Fatalf("generate tokens: %v", err)
	}
	claims, err := j.ValidateAccessToken(tokens.AccessToken)
	if err != nil {
		t.Fatalf("validate token: %v", err)
	}
	if claims.UserID != "user1" || claims.Username != "alice" || claims.Role != "admin" {
		t.Fatalf("unexpected claims %+v", claims)
	}
}

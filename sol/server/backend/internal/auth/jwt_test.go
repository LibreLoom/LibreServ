package auth

import (
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
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

func TestValidateTokenRejectsHS512(t *testing.T) {
	secret := "secret"
	j := NewJWTManager(secret, 15*time.Minute, 24*time.Hour)

	claims := &Claims{
		UserID:    "user1",
		Username:  "alice",
		Role:      "admin",
		TokenType: "access",
		JTI:       "test-jti",
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Issuer:    "libreserv",
		},
	}
	hs512, err := jwt.NewWithClaims(jwt.SigningMethodHS512, claims).SignedString([]byte(secret))
	if err != nil {
		t.Fatalf("sign HS512 token: %v", err)
	}
	if _, err := j.ValidateToken(hs512); err == nil {
		t.Fatal("expected HS512-signed token to be rejected")
	} else if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken, got %v", err)
	}

	pair, err := j.GenerateTokenPair("user1", "alice", "admin")
	if err != nil {
		t.Fatalf("generate HS256 tokens: %v", err)
	}
	if _, err := j.ValidateAccessToken(pair.AccessToken); err != nil {
		t.Fatalf("HS256 token should still validate: %v", err)
	}
}

package oidc

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
	"golang.org/x/crypto/bcrypt"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

const testEncryptionKey = "0123456789abcdef0123456789abcdef"

type stubUserGetter struct {
	user *User
	err  error
}

func (g *stubUserGetter) GetUserByID(ctx context.Context, id string) (*User, error) {
	if g.err != nil {
		return nil, g.err
	}
	return g.user, nil
}

func newTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "oidc.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newTestStorage(t *testing.T, user *User) *Storage {
	t.Helper()
	return NewStorage(newTestDB(t), &stubUserGetter{user: user}, testEncryptionKey, slog.Default())
}

func insertClient(t *testing.T, db *database.DB, clientID, secret string) {
	t.Helper()
	hash, err := bcrypt.GenerateFromPassword([]byte(secret), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("hash secret: %v", err)
	}
	_, err = db.SQL().Exec(
		`INSERT INTO oidc_clients (id, instance_id, client_id, client_secret, redirect_uris, scopes, name)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"id-"+clientID, "instance-1", clientID, string(hash), `["https://app.example/cb"]`, "openid email", "Demo App",
	)
	if err != nil {
		t.Fatalf("insert client: %v", err)
	}
}

func TestStorage_AuthRequestLifecycle(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()

	created, err := s.CreateAuthRequest(ctx, &oidc.AuthRequest{
		ClientID:     "app-1",
		RedirectURI:  "https://app.example/cb",
		Scopes:       []string{"openid", "email"},
		State:        "state-1",
		Nonce:        "nonce-1",
		ResponseType: oidc.ResponseTypeCode,
	}, "user-1")
	if err != nil {
		t.Fatalf("CreateAuthRequest: %v", err)
	}
	if created.GetClientID() != "app-1" || created.GetSubject() != "user-1" || created.GetNonce() != "nonce-1" {
		t.Errorf("auth request = %+v, want it to carry the request and user details", created)
	}
	if aud := created.GetAudience(); len(aud) != 1 || aud[0] != "app-1" {
		t.Errorf("audience = %v, want [app-1]", aud)
	}

	byID, err := s.AuthRequestByID(ctx, created.GetID())
	if err != nil || byID.GetID() != created.GetID() {
		t.Fatalf("AuthRequestByID = %v, %v, want the stored request", byID, err)
	}
	if _, err := s.AuthRequestByID(ctx, "missing"); err == nil {
		t.Error("AuthRequestByID for an unknown ID = nil error, want a not-found error")
	}

	if err := s.SaveAuthCode(ctx, created.GetID(), "code-1"); err != nil {
		t.Fatalf("SaveAuthCode: %v", err)
	}
	byCode, err := s.AuthRequestByCode(ctx, "code-1")
	if err != nil || byCode.GetID() != created.GetID() {
		t.Fatalf("AuthRequestByCode = %v, %v, want the stored request", byCode, err)
	}
	if _, err := s.AuthRequestByCode(ctx, "bogus"); err == nil {
		t.Error("AuthRequestByCode for an unknown code = nil error, want an invalid-code error")
	}

	if err := s.DeleteAuthRequest(ctx, created.GetID()); err != nil {
		t.Fatalf("DeleteAuthRequest: %v", err)
	}
	if _, err := s.AuthRequestByID(ctx, created.GetID()); err == nil {
		t.Error("the auth request is still retrievable after deletion")
	}
	if _, err := s.AuthRequestByCode(ctx, "code-1"); err == nil {
		t.Error("the auth code is still retrievable after the request was deleted")
	}
}

func TestStorage_CreateAccessToken(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	req := &AuthRequest{id: "req-1", clientID: "app-1", subject: "user-1", audience: []string{"app-1"}, scopes: []string{"openid"}}

	tokenID, expiration, err := s.CreateAccessToken(context.Background(), req)
	if err != nil {
		t.Fatalf("CreateAccessToken: %v", err)
	}
	if tokenID == "" {
		t.Error("token ID is empty")
	}
	if until := time.Until(expiration); until <= 0 || until > time.Hour {
		t.Errorf("expiration is in %v, want it within the next hour", until)
	}

	stored, ok := s.tokens[tokenID]
	if !ok {
		t.Fatal("the token was not stored")
	}
	if stored.applicationID != "app-1" || stored.subject != "user-1" {
		t.Errorf("stored token = %+v, want it bound to app-1/user-1", stored)
	}
}

func TestStorage_CreateAccessAndRefreshTokens_AuthCodeFlow(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	authTime := time.Now().Add(-time.Minute)
	req := &AuthRequest{id: "app-1", subject: "user-1", audience: []string{"app-1"}, scopes: []string{"openid"}, authTime: authTime}

	tokenID, refreshID, _, err := s.CreateAccessAndRefreshTokens(context.Background(), req, "")
	if err != nil {
		t.Fatalf("CreateAccessAndRefreshTokens: %v", err)
	}

	rt, ok := s.refreshTokens[refreshID]
	if !ok {
		t.Fatal("the refresh token was not stored")
	}
	if rt.accessTokenID != tokenID || rt.userID != "user-1" || !rt.authTime.Equal(authTime) {
		t.Errorf("refresh token = %+v, want it linked to the access token and the auth time", rt)
	}
	if s.tokens[tokenID].refreshTokenID != refreshID {
		t.Errorf("access token refresh ID = %q, want %q", s.tokens[tokenID].refreshTokenID, refreshID)
	}
}

func TestStorage_CreateAccessAndRefreshTokens_RotatesRefreshToken(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()
	authReq := &AuthRequest{id: "app-1", subject: "user-1", audience: []string{"app-1"}, scopes: []string{"openid"}}

	oldToken, oldRefresh, _, err := s.CreateAccessAndRefreshTokens(ctx, authReq, "")
	if err != nil {
		t.Fatalf("initial token issuance: %v", err)
	}

	refreshReq, err := s.TokenRequestByRefreshToken(ctx, oldRefresh)
	if err != nil {
		t.Fatalf("TokenRequestByRefreshToken: %v", err)
	}

	newToken, newRefresh, _, err := s.CreateAccessAndRefreshTokens(ctx, refreshReq, oldRefresh)
	if err != nil {
		t.Fatalf("refresh rotation: %v", err)
	}
	if newRefresh == oldRefresh || newToken == oldToken {
		t.Error("rotation reused the previous token IDs")
	}
	if _, ok := s.refreshTokens[oldRefresh]; ok {
		t.Error("the rotated-out refresh token is still valid")
	}
	if _, ok := s.tokens[oldToken]; ok {
		t.Error("the access token belonging to the rotated-out refresh token was not revoked")
	}

	if _, _, _, err := s.CreateAccessAndRefreshTokens(ctx, refreshReq, "unknown-refresh"); !errors.Is(err, op.ErrInvalidRefreshToken) {
		t.Errorf("rotation with an unknown refresh token = %v, want ErrInvalidRefreshToken", err)
	}
}

func TestStorage_RefreshTokenLookups(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()
	authReq := &AuthRequest{id: "app-1", subject: "user-1", audience: []string{"app-1"}, scopes: []string{"openid"}, authTime: time.Now()}

	_, refreshID, _, err := s.CreateAccessAndRefreshTokens(ctx, authReq, "")
	if err != nil {
		t.Fatalf("token issuance: %v", err)
	}

	userID, tokenID, err := s.GetRefreshTokenInfo(ctx, "app-1", refreshID)
	if err != nil {
		t.Fatalf("GetRefreshTokenInfo: %v", err)
	}
	if userID != "user-1" || tokenID != refreshID {
		t.Errorf("GetRefreshTokenInfo = %q, %q, want user-1 and %q", userID, tokenID, refreshID)
	}

	if _, _, err := s.GetRefreshTokenInfo(ctx, "app-1", "missing"); !errors.Is(err, op.ErrInvalidRefreshToken) {
		t.Errorf("GetRefreshTokenInfo for an unknown token = %v, want ErrInvalidRefreshToken", err)
	}
	if _, err := s.TokenRequestByRefreshToken(ctx, "missing"); !errors.Is(err, op.ErrInvalidRefreshToken) {
		t.Errorf("TokenRequestByRefreshToken for an unknown token = %v, want ErrInvalidRefreshToken", err)
	}
}

func TestStorage_TerminateSession(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()
	authReq := &AuthRequest{id: "app-1", subject: "user-1", audience: []string{"app-1"}, scopes: []string{"openid"}}

	tokenID, refreshID, _, err := s.CreateAccessAndRefreshTokens(ctx, authReq, "")
	if err != nil {
		t.Fatalf("token issuance: %v", err)
	}

	if err := s.TerminateSession(ctx, "other-user", "app-1"); err != nil {
		t.Fatalf("TerminateSession: %v", err)
	}
	if _, ok := s.tokens[tokenID]; !ok {
		t.Fatal("terminating another user's session revoked this user's token")
	}

	if err := s.TerminateSession(ctx, "user-1", "app-1"); err != nil {
		t.Fatalf("TerminateSession: %v", err)
	}
	if _, ok := s.tokens[tokenID]; ok {
		t.Error("the access token survived session termination")
	}
	if _, ok := s.refreshTokens[refreshID]; ok {
		t.Error("the refresh token survived session termination")
	}
}

func TestStorage_RevokeToken(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()

	accessOnly, err := s.createAccessToken("app-1", "", "user-1", []string{"app-1"}, []string{"openid"})
	if err != nil {
		t.Fatalf("createAccessToken: %v", err)
	}
	if oidcErr := s.RevokeToken(ctx, accessOnly.id, "user-1", "other-app"); oidcErr == nil {
		t.Error("revoking a token for the wrong client = nil error, want invalid_client")
	}
	if oidcErr := s.RevokeToken(ctx, accessOnly.id, "user-1", "app-1"); oidcErr != nil {
		t.Fatalf("RevokeToken: %v", oidcErr)
	}
	if _, ok := s.tokens[accessOnly.id]; ok {
		t.Error("the access token was not deleted")
	}

	tokenID, refreshID, _, err := s.CreateAccessAndRefreshTokens(ctx, &AuthRequest{id: "app-1", subject: "user-1", scopes: []string{"openid"}}, "")
	if err != nil {
		t.Fatalf("token issuance: %v", err)
	}
	if oidcErr := s.RevokeToken(ctx, refreshID, "user-1", "other-app"); oidcErr == nil {
		t.Error("revoking a refresh token for the wrong client = nil error, want invalid_client")
	}
	if oidcErr := s.RevokeToken(ctx, refreshID, "user-1", "app-1"); oidcErr != nil {
		t.Fatalf("RevokeToken on the refresh token: %v", oidcErr)
	}
	if _, ok := s.refreshTokens[refreshID]; ok {
		t.Error("the refresh token was not deleted")
	}
	if _, ok := s.tokens[tokenID]; ok {
		t.Error("the paired access token was not deleted with the refresh token")
	}

	if oidcErr := s.RevokeToken(ctx, "unknown", "user-1", "app-1"); oidcErr != nil {
		t.Errorf("revoking an unknown token = %v, want nil per RFC 7009", oidcErr)
	}
}

func TestStorage_GetClientByClientID(t *testing.T) {
	db := newTestDB(t)
	s := NewStorage(db, &stubUserGetter{user: &User{ID: "user-1"}}, testEncryptionKey, slog.Default())
	insertClient(t, db, "app-1", "s3cr3t")
	ctx := context.Background()

	client, err := s.GetClientByClientID(ctx, "app-1")
	if err != nil {
		t.Fatalf("GetClientByClientID: %v", err)
	}
	if client.GetID() != "app-1" {
		t.Errorf("client ID = %q, want app-1", client.GetID())
	}
	if uris := client.RedirectURIs(); len(uris) != 1 || uris[0] != "https://app.example/cb" {
		t.Errorf("redirect URIs = %v, want the stored callback", uris)
	}
	if _, ok := s.clients["app-1"]; !ok {
		t.Error("the client was not cached after the DB lookup")
	}

	// The second lookup is served from the cache even after the row is deleted.
	if _, err := db.SQL().Exec(`DELETE FROM oidc_clients WHERE client_id = ?`, "app-1"); err != nil {
		t.Fatalf("delete client: %v", err)
	}
	if _, err := s.GetClientByClientID(ctx, "app-1"); err != nil {
		t.Errorf("cached lookup = %v, want the cached client", err)
	}

	if _, err := s.GetClientByClientID(ctx, "missing"); err == nil {
		t.Error("GetClientByClientID for an unknown client = nil error, want a not-found error")
	}
}

func TestStorage_GetClientByClientID_InvalidRedirectURIsJSON(t *testing.T) {
	db := newTestDB(t)
	s := NewStorage(db, &stubUserGetter{}, testEncryptionKey, slog.Default())
	if _, err := db.SQL().Exec(
		`INSERT INTO oidc_clients (id, instance_id, client_id, client_secret, redirect_uris, scopes, name)
		 VALUES ('id-1', 'instance-1', 'app-1', 'hash', 'not-json', 'openid', 'Demo')`,
	); err != nil {
		t.Fatalf("insert client: %v", err)
	}

	if _, err := s.GetClientByClientID(context.Background(), "app-1"); err == nil {
		t.Error("GetClientByClientID with corrupt redirect_uris = nil error, want a parse error")
	}
}

func TestStorage_AuthorizeClientIDSecret(t *testing.T) {
	db := newTestDB(t)
	s := NewStorage(db, &stubUserGetter{}, testEncryptionKey, slog.Default())
	insertClient(t, db, "app-1", "s3cr3t")
	ctx := context.Background()

	if err := s.AuthorizeClientIDSecret(ctx, "app-1", "s3cr3t"); err != nil {
		t.Fatalf("AuthorizeClientIDSecret with the correct secret: %v", err)
	}
	if err := s.AuthorizeClientIDSecret(ctx, "app-1", "wrong"); err == nil {
		t.Error("AuthorizeClientIDSecret with a wrong secret = nil error, want a rejection")
	}
	if err := s.AuthorizeClientIDSecret(ctx, "missing", "s3cr3t"); err == nil {
		t.Error("AuthorizeClientIDSecret for an unknown client = nil error, want a not-found error")
	}
}

func TestStorage_SigningKeyAndKeySet(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()

	// KeySet on a fresh DB must generate the current key and serve its public half.
	keys, err := s.KeySet(ctx)
	if err != nil {
		t.Fatalf("KeySet: %v", err)
	}
	if len(keys) != 1 {
		t.Fatalf("KeySet returned %d keys, want 1", len(keys))
	}
	if keys[0].Use() != "sig" || keys[0].Algorithm() != "RS256" {
		t.Errorf("key use/algorithm = %q/%q, want sig/RS256", keys[0].Use(), keys[0].Algorithm())
	}
	if _, ok := keys[0].Key().(*rsa.PublicKey); !ok {
		t.Errorf("JWKS key type = %T, want *rsa.PublicKey", keys[0].Key())
	}

	signing, err := s.SigningKey(ctx)
	if err != nil {
		t.Fatalf("SigningKey: %v", err)
	}
	if signing.ID() == "" || signing.SignatureAlgorithm() != "RS256" {
		t.Errorf("signing key = %q/%q, want an ID and RS256", signing.ID(), signing.SignatureAlgorithm())
	}
	if _, ok := signing.Key().(*rsa.PrivateKey); !ok {
		t.Errorf("signing key type = %T, want *rsa.PrivateKey", signing.Key())
	}

	// The persisted key is reused rather than regenerated.
	again, err := s.SigningKey(ctx)
	if err != nil {
		t.Fatalf("SigningKey (second call): %v", err)
	}
	if again.ID() != signing.ID() {
		t.Errorf("second SigningKey ID = %q, want the persisted %q", again.ID(), signing.ID())
	}

	// Now that a key row exists, KeySet serves the stored public keys.
	stored, err := s.KeySet(ctx)
	if err != nil {
		t.Fatalf("KeySet after persistence: %v", err)
	}
	if len(stored) != 1 || stored[0].ID() != signing.ID() {
		t.Errorf("KeySet = %v, want the stored key %q", stored, signing.ID())
	}

	algs, err := s.SignatureAlgorithms(ctx)
	if err != nil || len(algs) != 1 || algs[0] != "RS256" {
		t.Errorf("SignatureAlgorithms = %v, %v, want [RS256]", algs, err)
	}
}

func TestEnsureSigningKey_WrongEncryptionKey(t *testing.T) {
	db := newTestDB(t)

	if _, err := EnsureSigningKey(db, testEncryptionKey); err != nil {
		t.Fatalf("EnsureSigningKey: %v", err)
	}
	if _, err := EnsureSigningKey(db, "ffffffffffffffffffffffffffffffff"); err == nil {
		t.Error("EnsureSigningKey with a different encryption key = nil error, want a decryption failure")
	}
}

func TestEncryptDecryptPEM(t *testing.T) {
	plaintext := []byte("-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n")

	ciphertext, err := encryptPEM(plaintext, testEncryptionKey+"-extra-bytes-are-truncated")
	if err != nil {
		t.Fatalf("encryptPEM: %v", err)
	}
	got, err := decryptPEM(ciphertext, testEncryptionKey)
	if err != nil {
		t.Fatalf("decryptPEM: %v", err)
	}
	if string(got) != string(plaintext) {
		t.Errorf("round-tripped PEM = %q, want %q", got, plaintext)
	}

	if _, err := decryptPEM([]byte("short"), testEncryptionKey); err == nil {
		t.Error("decryptPEM on a truncated ciphertext = nil error, want an error")
	}
	if _, err := decryptPEM(ciphertext, "ffffffffffffffffffffffffffffffff"); err == nil {
		t.Error("decryptPEM with the wrong key = nil error, want an authentication failure")
	}
	if _, err := encryptPEM(plaintext, "too-short"); err == nil {
		t.Error("encryptPEM with an invalid key size = nil error, want a cipher error")
	}
}

func TestParsePrivateKey_Errors(t *testing.T) {
	if _, err := parsePrivateKey([]byte("not pem")); err == nil {
		t.Error("parsePrivateKey on non-PEM input = nil error, want an error")
	}
	if _, err := parseRSAPublicKey([]byte("not pem")); err == nil {
		t.Error("parseRSAPublicKey on non-PEM input = nil error, want an error")
	}
	if _, err := parseRSAPublicKey([]byte("-----BEGIN PUBLIC KEY-----\nZm9v\n-----END PUBLIC KEY-----\n")); err == nil {
		t.Error("parseRSAPublicKey on a malformed key = nil error, want an error")
	}
}

func TestStorage_Userinfo(t *testing.T) {
	user := &User{ID: "user-1", Username: "max", Email: "max@example.com", Role: "admin"}
	s := newTestStorage(t, user)
	ctx := context.Background()

	token, err := s.createAccessToken("app-1", "", user.ID, []string{"app-1"}, []string{oidc.ScopeOpenID, oidc.ScopeEmail, oidc.ScopeProfile, "groups"})
	if err != nil {
		t.Fatalf("createAccessToken: %v", err)
	}

	info := new(oidc.UserInfo)
	if err := s.SetUserinfoFromToken(ctx, info, token.id, user.ID, ""); err != nil {
		t.Fatalf("SetUserinfoFromToken: %v", err)
	}
	if info.Subject != "user-1" || info.Email != "max@example.com" || info.PreferredUsername != "max" {
		t.Errorf("userinfo = %+v, want the openid/email/profile claims filled", info)
	}
	if !bool(info.EmailVerified) {
		t.Error("email_verified = false, want true")
	}
	if groups, ok := info.Claims["groups"].([]string); !ok || len(groups) != 1 || groups[0] != "admin" {
		t.Errorf("groups claim = %v, want [admin]", info.Claims["groups"])
	}

	if err := s.SetUserinfoFromToken(ctx, new(oidc.UserInfo), "unknown", user.ID, ""); err == nil {
		t.Error("SetUserinfoFromToken for an unknown token = nil error, want a not-found error")
	}

	expired, err := s.createAccessToken("app-1", "", user.ID, []string{"app-1"}, []string{oidc.ScopeOpenID})
	if err != nil {
		t.Fatalf("createAccessToken: %v", err)
	}
	expired.expiration = time.Now().Add(-time.Minute)
	if err := s.SetUserinfoFromToken(ctx, new(oidc.UserInfo), expired.id, user.ID, ""); err == nil {
		t.Error("SetUserinfoFromToken for an expired token = nil error, want an expiry error")
	}

	// SetUserinfoFromScopes is a no-op in v1.
	if err := s.SetUserinfoFromScopes(ctx, new(oidc.UserInfo), user.ID, "app-1", []string{oidc.ScopeOpenID}); err != nil {
		t.Errorf("SetUserinfoFromScopes = %v, want nil", err)
	}
}

func TestStorage_SetUserinfoFromRequest(t *testing.T) {
	user := &User{ID: "user-1", Username: "max", Email: "max@example.com"}
	s := newTestStorage(t, user)
	req := &AuthRequest{id: "req-1", clientID: "app-1", subject: user.ID, scopes: []string{oidc.ScopeOpenID, oidc.ScopeEmail}}

	info := new(oidc.UserInfo)
	if err := s.SetUserinfoFromRequest(context.Background(), info, req, req.scopes); err != nil {
		t.Fatalf("SetUserinfoFromRequest: %v", err)
	}
	if info.Subject != user.ID || info.Email != user.Email {
		t.Errorf("userinfo = %+v, want the subject and email of %q", info, user.ID)
	}

	failing := NewStorage(newTestDB(t), &stubUserGetter{err: fmt.Errorf("user lookup failed")}, testEncryptionKey, slog.Default())
	if err := failing.SetUserinfoFromRequest(context.Background(), new(oidc.UserInfo), req, req.scopes); err == nil {
		t.Error("SetUserinfoFromRequest with a failing user lookup = nil error, want the lookup error")
	}
}

func TestStorage_SetIntrospectionFromToken(t *testing.T) {
	user := &User{ID: "user-1", Username: "max", Email: "max@example.com"}
	s := newTestStorage(t, user)
	ctx := context.Background()

	token, err := s.createAccessToken("app-1", "", user.ID, []string{"app-1"}, []string{oidc.ScopeOpenID, oidc.ScopeEmail})
	if err != nil {
		t.Fatalf("createAccessToken: %v", err)
	}

	resp := new(oidc.IntrospectionResponse)
	if err := s.SetIntrospectionFromToken(ctx, resp, token.id, user.ID, "app-1"); err != nil {
		t.Fatalf("SetIntrospectionFromToken: %v", err)
	}
	if resp.ClientID != "app-1" || resp.Subject != user.ID || resp.Email != user.Email {
		t.Errorf("introspection = %+v, want it to describe the token for %q", resp, user.ID)
	}
	if len(resp.Scope) != 2 {
		t.Errorf("scope = %v, want the two token scopes", resp.Scope)
	}

	if err := s.SetIntrospectionFromToken(ctx, new(oidc.IntrospectionResponse), token.id, user.ID, "other-app"); err == nil {
		t.Error("introspection for a client outside the audience = nil error, want a rejection")
	}
	if err := s.SetIntrospectionFromToken(ctx, new(oidc.IntrospectionResponse), "unknown", user.ID, "app-1"); err == nil {
		t.Error("introspection for an unknown token = nil error, want a not-found error")
	}

	token.expiration = time.Now().Add(-time.Minute)
	if err := s.SetIntrospectionFromToken(ctx, new(oidc.IntrospectionResponse), token.id, user.ID, "app-1"); err == nil {
		t.Error("introspection for an expired token = nil error, want an expiry error")
	}
}

func TestStorage_MiscOpStorageMethods(t *testing.T) {
	s := newTestStorage(t, &User{ID: "user-1"})
	ctx := context.Background()

	claims, err := s.GetPrivateClaimsFromScopes(ctx, "user-1", "app-1", []string{oidc.ScopeOpenID})
	if err != nil || claims != nil {
		t.Errorf("GetPrivateClaimsFromScopes = %v, %v, want nil, nil", claims, err)
	}
	if _, err := s.GetKeyByIDAndClientID(ctx, "key-1", "app-1"); err == nil {
		t.Error("GetKeyByIDAndClientID = nil error, want an unsupported error")
	}

	allowed, err := s.ValidateJWTProfileScopes(ctx, "user-1", []string{oidc.ScopeOpenID, "email"})
	if err != nil {
		t.Fatalf("ValidateJWTProfileScopes: %v", err)
	}
	if len(allowed) != 1 || allowed[0] != oidc.ScopeOpenID {
		t.Errorf("allowed scopes = %v, want only openid", allowed)
	}

	if err := s.Health(ctx); err != nil {
		t.Errorf("Health = %v, want nil", err)
	}
	empty := NewStorage(nil, &stubUserGetter{}, testEncryptionKey, slog.Default())
	if err := empty.Health(ctx); err != nil {
		t.Errorf("Health without a DB = %v, want nil", err)
	}
}

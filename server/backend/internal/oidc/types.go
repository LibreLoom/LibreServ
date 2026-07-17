package oidc

import (
	"crypto/rsa"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// ============================================================================
// DB row structs (mapped to 005_oidc.sql tables)
// ============================================================================

// Client represents an OIDC client registration (oidc_clients table).
type Client struct {
	ID           string    `db:"id" json:"id"`
	InstanceID   string    `db:"instance_id" json:"instance_id"`
	ClientID     string    `db:"client_id" json:"client_id"`
	ClientSecret string    `db:"client_secret" json:"-"`
	RedirectURIs []string  `db:"-" json:"redirect_uris"`
	Scopes       string    `db:"scopes" json:"scopes"`
	Name         string    `db:"name" json:"name"`
	CreatedAt    time.Time `db:"created_at" json:"created_at"`
	UpdatedAt    time.Time `db:"updated_at" json:"updated_at"`
}

func (c *Client) Scan(value interface{}) error {
	if value == nil {
		return nil
	}
	switch v := value.(type) {
	case []byte:
		if err := json.Unmarshal(v, &c.RedirectURIs); err != nil {
			c.RedirectURIs = []string{string(v)}
		}
	case string:
		if err := json.Unmarshal([]byte(v), &c.RedirectURIs); err != nil {
			c.RedirectURIs = []string{v}
		}
	default:
		return fmt.Errorf("unsupported redirect_uris type %T", value)
	}
	return nil
}

func (c *Client) Value() (driver.Value, error) {
	if c.RedirectURIs == nil {
		return "[]", nil
	}
	return json.Marshal(c.RedirectURIs)
}

// ============================================================================
// AuthRequest — in-memory, implements op.AuthRequest
// ============================================================================

// AuthRequest represents an in-memory OIDC auth request.
type AuthRequest struct {
	id            string
	clientID      string
	redirectURI   string
	scopes        []string
	state         string
	subject       string
	audience      []string
	authTime      time.Time
	isDone        bool
	acr           string
	amr           []string
	responseType  oidc.ResponseType
	responseMode  oidc.ResponseMode
	nonce         string
	codeChallenge *oidc.CodeChallenge
}

var _ op.AuthRequest = (*AuthRequest)(nil)

func (r *AuthRequest) GetID() string                         { return r.id }
func (r *AuthRequest) GetACR() string                        { return r.acr }
func (r *AuthRequest) GetAMR() []string                      { return r.amr }
func (r *AuthRequest) GetAudience() []string                 { return r.audience }
func (r *AuthRequest) GetAuthTime() time.Time                { return r.authTime }
func (r *AuthRequest) GetClientID() string                   { return r.clientID }
func (r *AuthRequest) GetCodeChallenge() *oidc.CodeChallenge { return r.codeChallenge }
func (r *AuthRequest) GetNonce() string                      { return r.nonce }
func (r *AuthRequest) GetRedirectURI() string                { return r.redirectURI }
func (r *AuthRequest) GetResponseType() oidc.ResponseType    { return r.responseType }
func (r *AuthRequest) GetResponseMode() oidc.ResponseMode    { return r.responseMode }
func (r *AuthRequest) GetScopes() []string                   { return r.scopes }
func (r *AuthRequest) GetState() string                      { return r.state }
func (r *AuthRequest) GetSubject() string                    { return r.subject }
func (r *AuthRequest) Done() bool                            { return r.isDone }

// Setters (called by storage.CreateAuthRequest).
func (r *AuthRequest) SetDone()                                { r.isDone = true }
func (r *AuthRequest) SetAMR(amr []string)                     { r.amr = amr }
func (r *AuthRequest) SetCodeChallenge(cc *oidc.CodeChallenge) { r.codeChallenge = cc }

// ============================================================================
// Token / RefreshToken — in-memory
// ============================================================================

// Token is an in-memory access token.
type Token struct {
	id             string
	applicationID  string
	subject        string
	refreshTokenID string
	audience       []string
	scopes         []string
	expiration     time.Time
}

// RefreshToken is an in-memory refresh token.
type RefreshToken struct {
	id            string
	applicationID string
	userID        string
	accessTokenID string
	audience      []string
	scopes        []string
	amr           []string
	authTime      time.Time
	expiration    time.Time
}

// RefreshTokenRequest implements op.RefreshTokenRequest.
type RefreshTokenRequest struct {
	applicationID string
	userID        string
	amr           []string
	authTime      time.Time
	scopes        []string
}

var _ op.RefreshTokenRequest = (*RefreshTokenRequest)(nil)

func (r *RefreshTokenRequest) GetApplicationID() string         { return r.applicationID }
func (r *RefreshTokenRequest) GetUserID() string                { return r.userID }
func (r *RefreshTokenRequest) GetAMR() []string                 { return r.amr }
func (r *RefreshTokenRequest) GetAuthTime() time.Time           { return r.authTime }
func (r *RefreshTokenRequest) GetAudience() []string            { return nil }
func (r *RefreshTokenRequest) GetClientID() string              { return r.applicationID }
func (r *RefreshTokenRequest) GetSubject() string               { return r.userID }
func (r *RefreshTokenRequest) SetCurrentScopes(scopes []string) { r.scopes = scopes }
func (r *RefreshTokenRequest) GetScopes() []string              { return r.scopes }

// ============================================================================
// Consent (persistent)
// ============================================================================

// Consent is a user consent record from the oidc_consent table.
type Consent struct {
	ID        string    `db:"id" json:"id"`
	UserID    string    `db:"user_id" json:"user_id"`
	ClientID  string    `db:"client_id" json:"client_id"`
	Scopes    string    `db:"scopes" json:"scopes"`
	GrantedAt time.Time `db:"granted_at" json:"granted_at"`
}

// ============================================================================
// Signing key types — implement op.SigningKey and op.Key
// ============================================================================

// SigningKey wraps an RSA private key.
type signingKey struct {
	id        string
	algorithm jose.SignatureAlgorithm
	privKey   *rsa.PrivateKey
}

var _ op.SigningKey = (*signingKey)(nil)

func (k *signingKey) SignatureAlgorithm() jose.SignatureAlgorithm {
	return k.algorithm
}

func (k *signingKey) Key() any {
	return k.privKey
}

func (k *signingKey) ID() string {
	return k.id
}

// publicKey wraps an RSA public key for JWKS.
type publicKey struct {
	id        string
	algorithm jose.SignatureAlgorithm
	pubKey    *rsa.PublicKey
}

var _ op.Key = (*publicKey)(nil)

func (k *publicKey) ID() string                         { return k.id }
func (k *publicKey) Algorithm() jose.SignatureAlgorithm { return k.algorithm }
func (k *publicKey) Use() string                        { return "sig" }
func (k *publicKey) Key() any                           { return k.pubKey }

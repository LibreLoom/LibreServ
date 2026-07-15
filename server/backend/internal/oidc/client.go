package oidc

import (
	"time"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

// OIDCClient wraps a Client DB row and implements the op.Client interface.
var _ op.Client = (*OIDCClient)(nil)

// OIDCClient implements op.Client for a registered OIDC application.
type OIDCClient struct {
	*Client
}

// GetID returns the client_id.
func (c *OIDCClient) GetID() string {
	return c.Client.ClientID
}

// RedirectURIs returns the registered redirect URIs for code and implicit flow.
func (c *OIDCClient) RedirectURIs() []string {
	return c.Client.RedirectURIs
}

// PostLogoutRedirectURIs returns registered post-logout redirect URIs.
// For v1, LibreServ handles logout via the main app; no dedicated URIs.
func (c *OIDCClient) PostLogoutRedirectURIs() []string {
	return nil
}

// ApplicationType returns the type of client (web for server-side apps).
func (c *OIDCClient) ApplicationType() op.ApplicationType {
	return op.ApplicationTypeWeb
}

// AuthMethod returns the authentication method (client_secret_basic).
func (c *OIDCClient) AuthMethod() oidc.AuthMethod {
	return oidc.AuthMethodBasic
}

// ResponseTypes returns all allowed response types (code, id_token token, id_token).
// These match the authorization_code flow with optional ID token in fragment.
func (c *OIDCClient) ResponseTypes() []oidc.ResponseType {
	return []oidc.ResponseType{
		oidc.ResponseTypeCode,
		oidc.ResponseTypeIDTokenOnly,
		oidc.ResponseTypeIDToken,
	}
}

// GrantTypes returns all allowed grant types.
func (c *OIDCClient) GrantTypes() []oidc.GrantType {
	return []oidc.GrantType{
		oidc.GrantTypeCode,
		oidc.GrantTypeRefreshToken,
	}
}

// LoginURL redirects the user agent to LibreServ's login page with the
// auth request ID. The existing login UI at /login will handle the
// authentication flow.
func (c *OIDCClient) LoginURL(id string) string {
	return "/login?auth_request_id=" + id
}

// AccessTokenType returns the type of access token (Bearer for opaque tokens).
func (c *OIDCClient) AccessTokenType() op.AccessTokenType {
	return op.AccessTokenTypeBearer
}

// IDTokenLifetime returns the lifetime of ID tokens (1 hour).
func (c *OIDCClient) IDTokenLifetime() time.Duration {
	return 1 * time.Hour
}

// DevMode disables compliance checks for non-production environments.
func (c *OIDCClient) DevMode() bool {
	return false
}

// RestrictAdditionalIdTokenScopes filters custom scopes for the ID token.
func (c *OIDCClient) RestrictAdditionalIdTokenScopes() func(scopes []string) []string {
	return func(scopes []string) []string {
		return scopes
	}
}

// RestrictAdditionalAccessTokenScopes filters custom scopes for the JWT access token.
func (c *OIDCClient) RestrictAdditionalAccessTokenScopes() func(scopes []string) []string {
	return func(scopes []string) []string {
		return scopes
	}
}

// IsScopeAllowed checks if a scope is permitted for this client.
// For v1, all registered scopes in the client definition are allowed.
func (c *OIDCClient) IsScopeAllowed(scope string) bool {
	// All standard OIDC scopes are allowed
	return true
}

// IDTokenUserinfoClaimsAssertion controls whether claims from profile, email,
// phone, and address scopes are included in the ID token even when an access
// token is issued (which would normally violate the OIDC Core spec).
func (c *OIDCClient) IDTokenUserinfoClaimsAssertion() bool {
	return false
}

// ClockSkew allows clients to instruct the OP to apply a clock skew on
// token times and expirations.
func (c *OIDCClient) ClockSkew() time.Duration {
	return 0
}

package oidc

import (
	"crypto/sha256"
	"log/slog"
	"net/http"

	"github.com/zitadel/oidc/v3/pkg/op"

	config "gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

// NewProvider constructs a complete OIDC provider and returns its http.Handler.
//
// The returned handler serves all OIDC endpoints on the issuer path:
//   - /.well-known/openid-configuration (discovery)
//   - /.well-known/jwks.json            (JWKS)
//   - /authorize                         (authorization)
//   - /token                             (token issuance)
//   - /userinfo                          (userinfo endpoint)
//   - /revoke                            (token revocation)
//   - /introspect                        (token introspection)
//
// The crypto key is derived from the JWT secret via SHA-256 (32 bytes),
// as required by the zitadel/oidc library for token encryption.
func NewProvider(storage op.Storage, issuer string, logger *slog.Logger) (http.Handler, error) {
	// Derive a 32-byte encryption key from the JWT secret.
	// This is used by op.NewOpenIDProvider for encrypting tokens (e.g. refresh tokens in cookie).
	cryptoKey := sha256.Sum256([]byte(config.Get().Auth.JWTSecret))

	// Build the OpenID Provider configuration.
	opConfig := &op.Config{
		CryptoKey: cryptoKey,

		// Enable PKCE (S256 code challenge method) — required for public clients.
		CodeMethodS256: true,

		// Allow client_secret POST authentication (in addition to HTTP Basic Auth).
		AuthMethodPost: true,

		// Enable private_key_jwt authentication method.
		AuthMethodPrivateKeyJWT: true,

		// Enable refresh_token grant type.
		GrantTypeRefreshToken: true,

		// Enable the `request` Object parameter for authorization requests.
		RequestObjectSupported: true,
	}

	// Build the OpenID Provider, allowing insecure (http) issuer URLs.
	provider, err := op.NewOpenIDProvider(issuer, opConfig, storage,
		op.WithAllowInsecure(),
		op.WithLogger(logger.WithGroup("op")),
	)
	if err != nil {
		return nil, err
	}
	// Return the raw OpenID Provider handler. The caller registers it on
	// specific paths (/.well-known/openid-configuration, /authorize,
	// /oauth/token, /userinfo, etc.) to avoid shadowing existing routes.
	return provider, nil
}

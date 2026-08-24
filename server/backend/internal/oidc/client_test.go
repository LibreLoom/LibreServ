package oidc

import (
	"testing"
	"time"

	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"
)

func TestOIDCClient_ImplementsOPClient(t *testing.T) {
	c := &OIDCClient{&Client{ClientID: "app-1", RedirectURIs: []string{"https://app.example/callback"}}}

	if got := c.GetID(); got != "app-1" {
		t.Errorf("GetID() = %q, want app-1", got)
	}
	if got := c.RedirectURIs(); len(got) != 1 || got[0] != "https://app.example/callback" {
		t.Errorf("RedirectURIs() = %v, want the registered callback", got)
	}
	if got := c.PostLogoutRedirectURIs(); got != nil {
		t.Errorf("PostLogoutRedirectURIs() = %v, want nil", got)
	}
	if got := c.ApplicationType(); got != op.ApplicationTypeWeb {
		t.Errorf("ApplicationType() = %v, want web", got)
	}
	if got := c.AuthMethod(); got != oidc.AuthMethodBasic {
		t.Errorf("AuthMethod() = %v, want client_secret_basic", got)
	}
	if got := c.AccessTokenType(); got != op.AccessTokenTypeBearer {
		t.Errorf("AccessTokenType() = %v, want bearer", got)
	}
	if got := c.IDTokenLifetime(); got != time.Hour {
		t.Errorf("IDTokenLifetime() = %v, want 1h", got)
	}
	if c.DevMode() {
		t.Error("DevMode() = true, want false")
	}
	if c.IDTokenUserinfoClaimsAssertion() {
		t.Error("IDTokenUserinfoClaimsAssertion() = true, want false")
	}
	if got := c.ClockSkew(); got != 0 {
		t.Errorf("ClockSkew() = %v, want 0", got)
	}
	if !c.IsScopeAllowed("openid") {
		t.Error("IsScopeAllowed(openid) = false, want true")
	}
	if got := c.LoginURL("req-42"); got != "/login?auth_request_id=req-42" {
		t.Errorf("LoginURL() = %q, want the login page with the request ID", got)
	}
}

func TestOIDCClient_ResponseAndGrantTypes(t *testing.T) {
	c := &OIDCClient{&Client{ClientID: "app-1"}}

	responseTypes := c.ResponseTypes()
	for _, want := range []oidc.ResponseType{oidc.ResponseTypeCode, oidc.ResponseTypeIDTokenOnly, oidc.ResponseTypeIDToken} {
		if !containsResponseType(responseTypes, want) {
			t.Errorf("ResponseTypes() = %v, want it to include %v", responseTypes, want)
		}
	}

	grantTypes := c.GrantTypes()
	if len(grantTypes) != 2 || grantTypes[0] != oidc.GrantTypeCode || grantTypes[1] != oidc.GrantTypeRefreshToken {
		t.Errorf("GrantTypes() = %v, want code and refresh_token", grantTypes)
	}
}

func containsResponseType(types []oidc.ResponseType, want oidc.ResponseType) bool {
	for _, rt := range types {
		if rt == want {
			return true
		}
	}
	return false
}

func TestOIDCClient_RestrictScopesPassesScopesThrough(t *testing.T) {
	c := &OIDCClient{&Client{ClientID: "app-1"}}
	scopes := []string{"openid", "custom"}

	if got := c.RestrictAdditionalIdTokenScopes()(scopes); len(got) != 2 || got[1] != "custom" {
		t.Errorf("RestrictAdditionalIdTokenScopes() = %v, want the scopes unchanged", got)
	}
	if got := c.RestrictAdditionalAccessTokenScopes()(scopes); len(got) != 2 || got[1] != "custom" {
		t.Errorf("RestrictAdditionalAccessTokenScopes() = %v, want the scopes unchanged", got)
	}
}

func TestClient_ScanAndValue(t *testing.T) {
	tests := []struct {
		name  string
		value interface{}
		want  []string
	}{
		{"json bytes", []byte(`["https://a.example/cb","https://b.example/cb"]`), []string{"https://a.example/cb", "https://b.example/cb"}},
		{"json string", `["https://a.example/cb"]`, []string{"https://a.example/cb"}},
		{"bare string falls back to a single URI", "https://a.example/cb", []string{"https://a.example/cb"}},
		{"bare bytes fall back to a single URI", []byte("https://a.example/cb"), []string{"https://a.example/cb"}},
		{"nil leaves the URIs unset", nil, nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var c Client
			if err := c.Scan(tc.value); err != nil {
				t.Fatalf("Scan(%v): %v", tc.value, err)
			}
			if len(c.RedirectURIs) != len(tc.want) {
				t.Fatalf("RedirectURIs = %v, want %v", c.RedirectURIs, tc.want)
			}
			for i, want := range tc.want {
				if c.RedirectURIs[i] != want {
					t.Errorf("RedirectURIs[%d] = %q, want %q", i, c.RedirectURIs[i], want)
				}
			}
		})
	}

	var c Client
	if err := c.Scan(42); err == nil {
		t.Error("Scan(int) = nil error, want an unsupported type error")
	}

	empty := &Client{}
	value, err := empty.Value()
	if err != nil {
		t.Fatalf("Value on an empty client: %v", err)
	}
	if value != "[]" {
		t.Errorf("Value with no URIs = %v, want []", value)
	}

	withURIs := &Client{RedirectURIs: []string{"https://a.example/cb"}}
	value, err = withURIs.Value()
	if err != nil {
		t.Fatalf("Value: %v", err)
	}
	if got := string(value.([]byte)); got != `["https://a.example/cb"]` {
		t.Errorf("Value = %s, want the JSON array of URIs", got)
	}
}

func TestAuthRequest_Accessors(t *testing.T) {
	authTime := time.Now().Truncate(time.Second)
	challenge := &oidc.CodeChallenge{Challenge: "abc", Method: oidc.CodeChallengeMethodS256}
	r := &AuthRequest{
		id:           "req-1",
		clientID:     "app-1",
		redirectURI:  "https://app.example/cb",
		scopes:       []string{"openid", "email"},
		state:        "state-1",
		subject:      "user-1",
		audience:     []string{"app-1"},
		authTime:     authTime,
		acr:          "acr-1",
		responseType: oidc.ResponseTypeCode,
		responseMode: oidc.ResponseModeQuery,
		nonce:        "nonce-1",
	}

	if r.GetID() != "req-1" || r.GetClientID() != "app-1" || r.GetSubject() != "user-1" {
		t.Errorf("identity accessors = %q/%q/%q, want req-1/app-1/user-1", r.GetID(), r.GetClientID(), r.GetSubject())
	}
	if r.GetRedirectURI() != "https://app.example/cb" || r.GetState() != "state-1" || r.GetNonce() != "nonce-1" {
		t.Error("redirect/state/nonce accessors returned unexpected values")
	}
	if r.GetACR() != "acr-1" || !r.GetAuthTime().Equal(authTime) {
		t.Error("ACR/auth time accessors returned unexpected values")
	}
	if len(r.GetScopes()) != 2 || len(r.GetAudience()) != 1 {
		t.Errorf("scopes = %v, audience = %v, want 2 scopes and 1 audience", r.GetScopes(), r.GetAudience())
	}
	if r.GetResponseType() != oidc.ResponseTypeCode || r.GetResponseMode() != oidc.ResponseModeQuery {
		t.Error("response type/mode accessors returned unexpected values")
	}
	if r.Done() || r.GetAMR() != nil || r.GetCodeChallenge() != nil {
		t.Error("a fresh auth request must not be done and must have no AMR or code challenge")
	}

	r.SetDone()
	r.SetAMR([]string{"pwd"})
	r.SetCodeChallenge(challenge)
	if !r.Done() || len(r.GetAMR()) != 1 || r.GetCodeChallenge() != challenge {
		t.Error("setters did not update the auth request")
	}
}

func TestRefreshTokenRequest_Accessors(t *testing.T) {
	authTime := time.Now()
	r := &RefreshTokenRequest{applicationID: "app-1", userID: "user-1", amr: []string{"pwd"}, authTime: authTime}

	if r.GetApplicationID() != "app-1" || r.GetClientID() != "app-1" {
		t.Errorf("application/client ID = %q/%q, want app-1", r.GetApplicationID(), r.GetClientID())
	}
	if r.GetUserID() != "user-1" || r.GetSubject() != "user-1" {
		t.Errorf("user ID/subject = %q/%q, want user-1", r.GetUserID(), r.GetSubject())
	}
	if len(r.GetAMR()) != 1 || !r.GetAuthTime().Equal(authTime) || r.GetAudience() != nil {
		t.Error("AMR/auth time/audience accessors returned unexpected values")
	}

	r.SetCurrentScopes([]string{"openid", "profile"})
	if got := r.GetScopes(); len(got) != 2 || got[0] != "openid" {
		t.Errorf("GetScopes() = %v, want the scopes set by SetCurrentScopes", got)
	}
}

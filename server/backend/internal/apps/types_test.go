package apps

import (
	"testing"
)

// TestRedactForAPI_StripsOIDCClientSecret is a regression test for the OIDC
// client secret leak: oidc_client_secret is set as a top-level config key by
// the installer (installer.go:211), and must be stripped from API responses.
// Previously only the "server" map was redacted, so the OIDC secret was
// returned via GET /api/apps/{id} to any authenticated user.
func TestRedactForAPI_StripsOIDCClientSecret(t *testing.T) {
	app := &InstalledApp{
		Config: map[string]interface{}{
			"app_name":           "nextcloud",
			"oidc_client_id":     "nextcloud-abc",
			"oidc_client_secret": "super-secret-value",
			"oidc_issuer":        "https://libreserv.example.com",
			"port":               8080,
		},
	}

	out := app.RedactForAPI()

	if v, ok := out.Config["oidc_client_secret"]; ok {
		t.Fatalf("oidc_client_secret leaked into API response: %v", v)
	}
	if v, ok := out.Config["oidc_client_id"]; !ok || v != "nextcloud-abc" {
		t.Errorf("oidc_client_id should be preserved, got %v", v)
	}
	if v, ok := out.Config["app_name"]; !ok || v != "nextcloud" {
		t.Errorf("non-secret config should be preserved, got %v", v)
	}
	// The original app must not be mutated.
	if _, ok := app.Config["oidc_client_secret"]; !ok {
		t.Errorf("RedactForAPI mutated the source app config")
	}
}

// TestStripServerContext_StripsOIDCClientSecret mirrors the above for the
// disk/DB persistence path (saveInstalledApp, createMetadataFile, updates).
func TestStripServerContext_StripsOIDCClientSecret(t *testing.T) {
	config := map[string]interface{}{
		"server": map[string]interface{}{
			"smtp_password": "smtp-secret",
		},
		"oidc_client_secret": "oidc-secret",
		"oidc_client_id":     "nextcloud-abc",
		"port":               8080,
	}

	safe := stripServerContext(config)

	if _, ok := safe["server"]; ok {
		t.Errorf("server map should be stripped")
	}
	if v, ok := safe["oidc_client_secret"]; ok {
		t.Fatalf("oidc_client_secret should be stripped, got %v", v)
	}
	if _, ok := safe["oidc_client_id"]; !ok {
		t.Errorf("oidc_client_id should be preserved")
	}
	if _, ok := safe["port"]; !ok {
		t.Errorf("non-secret config should be preserved")
	}
	// _compose_template_sha is intentionally NOT stripped here (it's read out
	// separately in saveInstalledApp); verify it survives.
	config["_compose_template_sha"] = "abc123"
	safe = stripServerContext(config)
	if v, ok := safe["_compose_template_sha"]; !ok || v != "abc123" {
		t.Errorf("_compose_template_sha should survive stripServerContext, got %v", v)
	}
}

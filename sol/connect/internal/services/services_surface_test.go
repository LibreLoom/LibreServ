package services

import (
	"database/sql"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/SolConnect/internal/config"
	"gt.plainskill.net/LibreLoom/SolConnect/internal/database"
	"gt.plainskill.net/LibreLoom/SolConnect/internal/security"
)

func serviceDevice(t *testing.T, db *sql.DB, plan string) string {
	t.Helper()
	accountID := security.GenerateID("acct")
	deviceID := security.GenerateID("dev")
	username := "smtp-" + security.RandomString(10)
	subdomain := "my-" + security.RandomString(10)
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id, username, smtp_password)
		 VALUES ($1, $2, 'hash', $3, $4, 'smtp-password')`,
		accountID, accountID+"@example.com", plan, username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO devices (id, account_id, plan_id, subdomain) VALUES ($1, $2, $3, $4)`,
		deviceID, accountID, plan, subdomain); err != nil {
		t.Fatal(err)
	}
	return deviceID
}

func TestProvisioningLocalCredentialTypes(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := serviceDevice(t, db, "one")
	svc := NewProvisioningService(db)

	old := config.C
	config.C.SMTP.RelayPublicHost = "smtp.example.com"
	config.C.Backup.Endpoint = "https://s3.example.com"
	config.C.Backup.BucketPrefix = "backups"
	config.C.Inference.BaseURL = "https://ai.example/v1"
	t.Cleanup(func() { config.C = old })

	smtpCreds, err := svc.Provision(deviceID, "smtp", "")
	if err != nil {
		t.Fatalf("Provision smtp: %v", err)
	}
	smtpData := smtpCreds["smtp"].(map[string]any)
	if smtpData["host"] != "smtp.example.com" || smtpData["username"] == "" {
		t.Fatalf("SMTP credentials = %#v", smtpData)
	}
	again, err := svc.Provision(deviceID, "smtp", "")
	if err != nil || again["smtp"].(map[string]any)["password"] != "smtp-password" {
		t.Fatalf("reused SMTP credentials = %#v, %v", again, err)
	}

	backup, err := svc.Provision(deviceID, "backup", "")
	if err != nil || !strings.Contains(backup["backup"].(map[string]any)["repo_path"].(string), "s3.example.com") {
		t.Fatalf("Provision backup = %#v, %v", backup, err)
	}
	ai, err := svc.Provision(deviceID, "ai", "")
	if err != nil || ai["ai"].(map[string]any)["base_url"] != "https://ai.example/v1" {
		t.Fatalf("Provision AI = %#v, %v", ai, err)
	}
	domain, err := svc.Provision(deviceID, "domain", "203.0.113.12")
	if err != nil || !strings.Contains(domain["domain"].(map[string]any)["domain"].(string), "my-") {
		t.Fatalf("Provision domain = %#v, %v", domain, err)
	}

	if _, err := svc.Provision(deviceID, "unknown", ""); err == nil {
		t.Fatal("unknown service was accepted")
	}
	if err := svc.Revoke(deviceID, "smtp"); err != nil {
		t.Fatalf("Revoke smtp: %v", err)
	}
	var active bool
	if err := db.QueryRow(
		`SELECT is_active FROM service_credentials WHERE device_id = $1 AND service_type = 'smtp'`,
		deviceID).Scan(&active); err != nil || active {
		t.Fatalf("SMTP active = %v, %v", active, err)
	}
}

func TestProvisioningQuotaAndMissingConfiguration(t *testing.T) {
	db := database.OpenTestDB(t)
	freeDevice := serviceDevice(t, db, "free")
	svc := NewProvisioningService(db)
	if _, err := svc.Provision(freeDevice, "backup", ""); err == nil || !strings.Contains(err.Error(), "not included") {
		t.Fatalf("free backup error = %v", err)
	}

	paidDevice := serviceDevice(t, db, "one")
	old := config.C
	config.C.Backup.Endpoint = ""
	config.C.Inference.BaseURL = ""
	t.Cleanup(func() { config.C = old })
	if _, err := svc.generateBackup("sub"); err == nil || !strings.Contains(err.Error(), "no backup provider") {
		t.Fatalf("missing backup error = %v", err)
	}
	ai, err := svc.generateAI(paidDevice, "sub")
	if err != nil || ai["ai"].(map[string]any)["base_url"] != "https://inference.neuralwatt.dev/v1" {
		t.Fatalf("default AI = %#v, %v", ai, err)
	}
	if _, err := svc.generateSMTP("missing"); err == nil {
		t.Fatal("missing SMTP device was accepted")
	}
	if _, err := svc.generateDomain("missing", "sub", ""); err == nil {
		t.Fatal("missing domain device was accepted")
	}
	if _, err := svc.generateTunnel(paidDevice, "sub"); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("missing tunnel error = %v", err)
	}
}

func TestProvisioningDeviceAndRouteHelpers(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := serviceDevice(t, db, "free")
	svc := NewProvisioningService(db)
	if got := svc.deviceSubdomainPrefix(deviceID); !strings.HasPrefix(got, "my-") {
		t.Fatalf("deviceSubdomainPrefix = %q", got)
	}
	if got := svc.deviceSubdomainPrefix("short"); got != "short" {
		t.Fatalf("short prefix = %q", got)
	}
	if got := svc.deviceHostname(deviceID, "my-device"); got != "my-device.free.servers.libreloom.org" {
		t.Fatalf("deviceHostname = %q", got)
	}
	if got := svc.deviceHostname("missing", "sub"); got != "" {
		t.Fatalf("missing device hostname = %q", got)
	}
	base := svc.deviceHostname(deviceID, svc.deviceSubdomainPrefix(deviceID))
	if err := svc.RegisterRoute(deviceID, ""); err == nil {
		t.Fatal("empty route registered")
	}
	if err := svc.RegisterRoute(deviceID, "app."+base); err == nil {
		t.Fatal("route without tunnel registered")
	}
	if err := svc.UnregisterRoute(deviceID, ""); err == nil {
		t.Fatal("empty route unregistered")
	}
	if err := svc.UnregisterRoute(deviceID, "app."+base); err != nil {
		t.Fatalf("UnregisterRoute without providers: %v", err)
	}
	routes, err := svc.listRouteHostnames(deviceID)
	if err != nil || len(routes) != 0 {
		t.Fatalf("routes = %#v, %v", routes, err)
	}
	if got := svc.findDeviceTunnelID(deviceID); got != "" {
		t.Fatalf("tunnel ID = %q", got)
	}
	if err := svc.deleteDeviceTunnel(deviceID); err != nil {
		t.Fatalf("delete absent tunnel: %v", err)
	}
	if got := mustJSON(map[string]string{"a": "b"}); got != `{"a":"b"}` {
		t.Fatalf("mustJSON = %q", got)
	}
}

// TestProvisioningRouteScope wires the route suite in above into a test
// binary: without this it is a helper that nothing calls.
func TestProvisioningRouteScope(t *testing.T) {
	db := database.OpenTestDB(t)
	routeScopeTest(t, NewProvisioningService(db))
}

func routeScopeTest(t *testing.T, svc *ProvisioningService) {
	t.Helper()
	db := svc.db
	a := serviceDevice(t, db, "one")
	b := serviceDevice(t, db, "one")

	baseA := svc.deviceHostname(a, svc.deviceSubdomainPrefix(a))
	baseB := svc.deviceHostname(b, svc.deviceSubdomainPrefix(b))
	if baseA == baseB {
		t.Fatalf("test devices collision: %q", baseA)
	}

	// Another device's hostnames are out of bounds — a device must not be
	// able to publish or tear down addresses its plan does not control.
	// The message is asserted so a refusal from a later, unrelated stage
	// (say, the tunnel lookup) cannot stand in for the scope check.
	for _, hostname := range []string{baseB, "app." + baseB} {
		_, err := svc.checkRouteHostname(a, hostname)
		if err == nil || !strings.Contains(err.Error(), "routes live under") {
			t.Fatalf("foreign hostname %q => %v, want a scope refusal", hostname, err)
		}
		if err := svc.RegisterRoute(a, hostname); err == nil || !strings.Contains(err.Error(), "routes live under") {
			t.Fatalf("register of foreign %q => %v", hostname, err)
		}
		if err := svc.UnregisterRoute(a, hostname); err == nil || !strings.Contains(err.Error(), "routes live under") {
			t.Fatalf("unregister of foreign %q => %v", hostname, err)
		}
	}

	// A hostname is normalized (lowercased, trailing root dot dropped)
	// before it is scoped, so a case-variant of the device's own valid
	// route is accepted and comes back lowercase — not refused as foreign.
	for _, spelling := range []string{
		"APP." + baseA,
		"app." + strings.ToUpper(baseA),
		"app." + baseA + ".",
	} {
		got, err := svc.checkRouteHostname(a, spelling)
		if err != nil || got != "app."+baseA {
			t.Fatalf("spelling %q => %q, %v, want normalized %q", spelling, got, err, "app."+baseA)
		}
	}

	// The device's own base hostname is not an app route.
	_, err := svc.checkRouteHostname(a, baseA)
	if err == nil || !strings.Contains(err.Error(), "routes live under") {
		t.Fatalf("own base hostname => %v, want a scope refusal", err)
	}

	// A hostname that is not under the base at all, and route labels that
	// are not one strict DNS label, are each refused by their own message.
	_, err = svc.checkRouteHostname(a, "post."+baseA+".evil.example.com")
	if err == nil || !strings.Contains(err.Error(), "routes live under") {
		t.Fatalf("hostname beyond the base => %v, want a scope refusal", err)
	}
	for _, bad := range []string{
		"..app." + baseA,                      // empty label
		"a-b c." + baseA,                      // space
		"x y z." + baseA,                      // spaces
		"-app." + baseA,                       // leading hyphen
		strings.Repeat("l", 64) + "." + baseA, // over 63 characters
	} {
		_, err := svc.checkRouteHostname(a, bad)
		if err == nil || !strings.Contains(err.Error(), "route names use lowercase letters, digits, and hyphens") {
			t.Fatalf("route label %q => %v, want a label refusal", bad, err)
		}
	}

	// A route one label under the device's own base hostname normalizes
	// and passes the scope check; in this test it only fails later, at the
	// tunnel lookup, and the tunnel message proves it got that far.
	err = svc.RegisterRoute(a, "nextcloud."+baseA)
	if err == nil || !strings.Contains(err.Error(), "no tunnel is provisioned") {
		t.Fatalf("valid own route = %v, want tunnel error", err)
	}

	// Nothing was written to the shared route table.
	for _, d := range []string{a, b} {
		routes, err := svc.listRouteHostnames(d)
		if err != nil || len(routes) != 0 {
			t.Fatalf("routes of %s = %#v, %v", d, routes, err)
		}
	}

	// A plan move changes the base hostname; a route this device
	// registered under its previous plan must still be one it can take
	// down — register it in the route table and make sure.
	stale := "nextcloud.old-plan.servers.libreloom.org"
	if _, err := db.Exec(`INSERT INTO device_routes (id, device_id, hostname) VALUES ($1, $2, $3)`,
		"route-scope-stale", a, stale); err != nil {
		t.Fatal(err)
	}
	if err := svc.UnregisterRoute(a, stale); err != nil {
		t.Fatalf("unregister of a route the device registered itself => %v", err)
	}
	if routes, err := svc.listRouteHostnames(a); err != nil || len(routes) != 0 {
		t.Fatalf("stale routes of %s = %#v, %v", a, routes, err)
	}

	// What the device did not register itself stays untouchable: a second
	// device asks to remove the same stale hostname and is refused as
	// foreign.
	if err := svc.UnregisterRoute(b, stale); err == nil || !strings.Contains(err.Error(), "routes live under") {
		t.Fatalf("another device's stale route => %v, want a scope refusal", err)
	}
	if routes, err := svc.listRouteHostnames(b); err != nil || len(routes) != 0 {
		t.Fatalf("routes of %s = %#v, %v", b, routes, err)
	}
}

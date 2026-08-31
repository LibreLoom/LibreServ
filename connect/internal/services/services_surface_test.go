package services

import (
	"database/sql"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func serviceDevice(t *testing.T, db *sql.DB, plan string) string {
	t.Helper()
	accountID := security.GenerateID("acct")
	deviceID := security.GenerateID("dev")
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id, username, smtp_password)
		 VALUES ($1, $2, 'hash', $3, 'smtp-user', 'smtp-password')`,
		accountID, accountID+"@example.com", plan); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO devices (id, account_id, plan_id, subdomain) VALUES ($1, $2, $3, 'my-device')`,
		deviceID, accountID, plan); err != nil {
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
	if smtpData["host"] != "smtp.example.com" || smtpData["username"] != "smtp-user" {
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
	if err != nil || !strings.Contains(domain["domain"].(map[string]any)["domain"].(string), "my-device") {
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
	if got := svc.deviceSubdomainPrefix(deviceID); got != "my-device" {
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
	if err := svc.RegisterRoute(deviceID, ""); err == nil {
		t.Fatal("empty route registered")
	}
	if err := svc.RegisterRoute(deviceID, "app.my-device.free.servers.libreloom.org"); err == nil {
		t.Fatal("route without tunnel registered")
	}
	if err := svc.UnregisterRoute(deviceID, ""); err == nil {
		t.Fatal("empty route unregistered")
	}
	if err := svc.UnregisterRoute(deviceID, "app.my-device.free.servers.libreloom.org"); err != nil {
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

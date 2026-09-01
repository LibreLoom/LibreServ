package handlers

import (
	"os"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

// TestMain loads config defaults so handlers that read config.C work in tests.
func TestMain(m *testing.M) {
	// Set defaults that handlers depend on
	config.C.SMTP.Host = "smtp.libreloom.org"
	config.C.SMTP.Port = 587
	config.C.SMTP.UseTLS = true
	config.C.SMTP.RelayPublicHost = "smtp.libreloom.org"
	config.C.Backup.Endpoint = "s3.libreloom.org"
	config.C.Backup.BucketPrefix = "libreserv-backup"
	config.C.Inference.BaseURL = "https://inference.neuralwatt.dev/v1"
	config.C.Auth.AdminTokenSecret = "admin-test-token"

	os.Exit(m.Run())
}

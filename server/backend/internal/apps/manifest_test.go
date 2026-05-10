package apps

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadManifest_NotFound(t *testing.T) {
	dir := t.TempDir()
	m, err := LoadManifest(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m != nil {
		t.Fatalf("expected nil manifest, got %+v", m)
	}
}

func TestLoadManifest_Valid(t *testing.T) {
	dir := t.TempDir()
	manifestYAML := `app_id: nextcloud
channel: stable
versions:
  - tag: "30.0.2"
    digest: "sha256:abc123"
    compose_template_sha: "def456"
    status: approved
    needs_config: false
    approved_at: "2026-05-01T00:00:00Z"
  - tag: "31.0.0"
    digest: "sha256:789abc"
    compose_template_sha: "ghi789"
    status: approved
    needs_config: true
    needs_config_reason: "Needs an API key."
    approved_at: "2026-05-05T00:00:00Z"
  - tag: "31.0.1"
    digest: "sha256:badf00d"
    compose_template_sha: "jkl012"
    status: revoked
    needs_config: false
    approved_at: "2026-05-06T00:00:00Z"
    revoked_at: "2026-05-07T00:00:00Z"
    revocation_reason: "Security problem."
    severity: malicious
`
	if err := os.WriteFile(filepath.Join(dir, "manifest.yaml"), []byte(manifestYAML), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	m, err := LoadManifest(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil manifest")
	}
	if m.AppID != "nextcloud" {
		t.Fatalf("expected app_id=nextcloud, got %s", m.AppID)
	}
	if len(m.Versions) != 3 {
		t.Fatalf("expected 3 versions, got %d", len(m.Versions))
	}
}

func TestManifest_LatestApproved(t *testing.T) {
	m := &Manifest{
		AppID:   "test",
		Channel: "stable",
		Versions: []ManifestVersion{
			{Tag: "1.0", Status: "approved", ApprovedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
			{Tag: "2.0", Status: "revoked", ApprovedAt: time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)},
			{Tag: "3.0", Status: "approved", ApprovedAt: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)},
		},
	}

	latest := m.LatestApproved()
	if latest == nil {
		t.Fatal("expected non-nil latest approved")
	}
	if latest.Tag != "3.0" {
		t.Fatalf("expected tag 3.0, got %s", latest.Tag)
	}
}

func TestManifest_LatestApproved_None(t *testing.T) {
	m := &Manifest{
		AppID:   "test",
		Channel: "stable",
		Versions: []ManifestVersion{
			{Tag: "1.0", Status: "revoked", ApprovedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		},
	}

	if latest := m.LatestApproved(); latest != nil {
		t.Fatalf("expected nil, got %+v", latest)
	}
}

func TestManifest_LatestApproved_Empty(t *testing.T) {
	m := &Manifest{AppID: "test"}
	if latest := m.LatestApproved(); latest != nil {
		t.Fatalf("expected nil, got %+v", latest)
	}
}

func TestManifest_GetVersion(t *testing.T) {
	m := &Manifest{
		Versions: []ManifestVersion{
			{Tag: "1.0", Digest: "sha256:aaa"},
			{Tag: "2.0", Digest: "sha256:bbb"},
		},
	}

	v := m.GetVersion("2.0")
	if v == nil {
		t.Fatal("expected non-nil version")
	}
	if v.Digest != "sha256:bbb" {
		t.Fatalf("expected digest bbb, got %s", v.Digest)
	}

	if v := m.GetVersion("9.0"); v != nil {
		t.Fatalf("expected nil for missing version, got %+v", v)
	}
}

func TestManifest_IsRevoked(t *testing.T) {
	m := &Manifest{
		Versions: []ManifestVersion{
			{Tag: "1.0", Status: "approved"},
			{Tag: "2.0", Status: "revoked", Severity: "malicious", RevocationReason: "bad"},
		},
	}

	if _, ok := m.IsRevoked("1.0"); ok {
		t.Fatal("expected 1.0 not revoked")
	}

	v, ok := m.IsRevoked("2.0")
	if !ok {
		t.Fatal("expected 2.0 revoked")
	}
	if v.Severity != "malicious" {
		t.Fatalf("expected severity=malicious, got %s", v.Severity)
	}

	if _, ok := m.IsRevoked("9.0"); ok {
		t.Fatal("expected 9.0 not found")
	}
}

func TestComposeTemplateSHA(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "docker-compose.yml.tmpl")
	content := []byte("services:\n  app:\n    image: test:latest\n")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	sha, err := ComposeTemplateSHA(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sha == "" {
		t.Fatal("expected non-empty SHA")
	}

	sha2, err := ComposeTemplateSHA(path)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sha != sha2 {
		t.Fatalf("same file should produce same SHA: %s vs %s", sha, sha2)
	}
}

func TestComposeTemplateSHA_Missing(t *testing.T) {
	_, err := ComposeTemplateSHA("/nonexistent/path")
	if err == nil {
		t.Fatal("expected error for missing file")
	}
}

func TestLoadManifest_BadYAML(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "manifest.yaml"), []byte("invalid: [yaml: content"), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	_, err := LoadManifest(dir)
	if err == nil {
		t.Fatal("expected error for malformed YAML")
	}
}

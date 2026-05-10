package apps

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Manifest struct {
	AppID    string            `yaml:"app_id" json:"app_id"`
	Channel  string            `yaml:"channel" json:"channel"`
	Versions []ManifestVersion `yaml:"versions" json:"versions"`
}

type ManifestVersion struct {
	Tag                string     `yaml:"tag" json:"tag"`
	Digest             string     `yaml:"digest" json:"digest"`
	ComposeTemplateSHA string     `yaml:"compose_template_sha" json:"compose_template_sha"`
	Status             string     `yaml:"status" json:"status"`
	NeedsConfig        bool       `yaml:"needs_config" json:"needs_config"`
	NeedsConfigReason  string     `yaml:"needs_config_reason,omitempty" json:"needs_config_reason,omitempty"`
	ApprovedAt         time.Time  `yaml:"approved_at" json:"approved_at"`
	RevokedAt          *time.Time `yaml:"revoked_at,omitempty" json:"revoked_at,omitempty"`
	RevocationReason   string     `yaml:"revocation_reason,omitempty" json:"revocation_reason,omitempty"`
	Severity           string     `yaml:"severity,omitempty" json:"severity,omitempty"`
}

func LoadManifest(appDir string) (*Manifest, error) {
	manifestPath := fmt.Sprintf("%s/manifest.yaml", appDir)
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &Manifest{AppID: "", Channel: "stable", Versions: []ManifestVersion{}}, nil
		}
		return nil, fmt.Errorf("failed to read manifest: %w", err)
	}

	var m Manifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("failed to parse manifest: %w", err)
	}

	return &m, nil
}

func (m *Manifest) LatestApproved() *ManifestVersion {
	var latest *ManifestVersion
	for i := range m.Versions {
		v := &m.Versions[i]
		if v.Status == "approved" {
			if latest == nil || v.ApprovedAt.After(latest.ApprovedAt) {
				latest = v
			}
		}
	}
	return latest
}

func (m *Manifest) GetVersion(tag string) *ManifestVersion {
	for i := range m.Versions {
		v := &m.Versions[i]
		if v.Tag == tag {
			return v
		}
	}
	return nil
}

func (m *Manifest) IsRevoked(tag string) (*ManifestVersion, bool) {
	for i := range m.Versions {
		v := &m.Versions[i]
		if v.Tag == tag && v.Status == "revoked" {
			return v, true
		}
	}
	return nil, false
}

func ComposeTemplateSHA(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("failed to read compose template: %w", err)
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

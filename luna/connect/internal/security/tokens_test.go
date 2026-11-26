package security

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestDeviceTokenIsTwentyCrockfordCharacters(t *testing.T) {
	token := DeviceToken()
	if len(token) != 20 || !IsDeviceTokenShape(token) {
		t.Fatalf("invalid device token %q", token)
	}
	if got := NormalizeDeviceToken(GroupCrockford(token)); got != token {
		t.Fatalf("grouped token normalized to %q, want %q", got, token)
	}
	if got := NormalizeDeviceToken(" 7k4m-2q9x-r8n3-6t5w-1pzh "); got != "7K4M2Q9XR8N36T5W1PZH" {
		t.Fatalf("lowercase grouped token normalized to %q", got)
	}
	if got := NormalizeDeviceToken("OIL"); got != "011" {
		t.Fatalf("lookalikes normalized to %q", got)
	}
	if IsDeviceTokenShape("A1B2C3") || IsDeviceTokenShape("0123456789ABCDEFGHJKMNPQRSTVWXYZ0") {
		t.Fatal("wrong-length Crockford value accepted as a device token")
	}
}

func TestAuthTokenIs256BitBase64URL(t *testing.T) {
	token := AuthToken()
	if !ValidAuthToken(token) || strings.Contains(token, "=") {
		t.Fatalf("invalid auth token %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		t.Fatalf("decoded token length=%d err=%v", len(raw), err)
	}
	for _, legacy := range []string{"", "ABCD-EFGH-JKMN-PQRS-TVWX", "not-a-token", token + "="} {
		if ValidAuthToken(legacy) {
			t.Fatalf("legacy or malformed token accepted: %q", legacy)
		}
	}
}

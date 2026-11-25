package security

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestDeviceUIDIsTwentyCrockfordCharacters(t *testing.T) {
	uid := DeviceUID()
	if len(uid) != 20 || !IsDeviceUIDShape(uid) {
		t.Fatalf("invalid Device UID %q", uid)
	}
	if got := NormalizeDeviceUID(GroupCrockford(uid)); got != uid {
		t.Fatalf("grouped UID normalized to %q, want %q", got, uid)
	}
	if IsDeviceUIDShape("A1B2C3") || IsDeviceUIDShape("0123456789ABCDEFGHJKMNPQRSTVWXYZ0") {
		t.Fatal("wrong-length Crockford value accepted as Device UID")
	}
}

func TestVerificationCodeShape(t *testing.T) {
	code := VerificationCode()
	if len(code) != 6 || !IsVerificationCodeShape(code) {
		t.Fatalf("invalid verification code %q", code)
	}
	if NormalizeVerificationCode(" a3f91c ") != "A3F91C" {
		t.Fatal("verification code did not normalize")
	}
	if IsVerificationCodeShape("A3F91") || IsVerificationCodeShape("A3F91G") {
		t.Fatal("malformed verification code accepted")
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

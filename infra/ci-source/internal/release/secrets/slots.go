package secrets

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Slot names for remembered values (keyring / encrypted file / Proton Pass).
const (
	SlotForgejoToken     = "forgejo-token"
	SlotMinisignPassword = "minisign-password" // tried against every key file
	SlotAndroidKeystore  = "android-keystore"  // base64 of the keystore file
	SlotAndroidStorePW   = "android-store-password"
	SlotAndroidKeyPW     = "android-key-password"
	SlotAndroidAlias     = "android-key-alias"
)

// SlotKey is the slot for a pasted secret key (text) of a signing product.
func SlotKey(id ID) string { return "minisign-key:" + string(id) }

// SlotPassword is the slot for a signing key's password.
func SlotPassword(id ID) string { return "minisign-password:" + string(id) }

func allSlots() []SlotInfo {
	return []SlotInfo{
		{Slot: SlotForgejoToken, Label: "Forgejo token"},
		{Slot: SlotKey(LibreServSigning), Label: "LibreServ signing key (pasted text)"},
		{Slot: SlotPassword(LibreServSigning), Label: "LibreServ signing key password"},
		{Slot: SlotKey(LunaSigning), Label: "Luna signing key (pasted text)"},
		{Slot: SlotPassword(LunaSigning), Label: "Luna signing key password"},
		{Slot: SlotMinisignPassword, Label: "Signing key password (any key)"},
		{Slot: SlotAndroidKeystore, Label: "Android keystore (base64)"},
		{Slot: SlotAndroidStorePW, Label: "Android keystore password"},
		{Slot: SlotAndroidKeyPW, Label: "Android key password"},
		{Slot: SlotAndroidAlias, Label: "Android key alias"},
	}
}

func validSlot(s string) bool {
	for _, x := range allSlots() {
		if x.Slot == s {
			return true
		}
	}
	return false
}

// ValueSource is a pluggable place values can come from (Proton Pass).
// Lookup returns every value it has for the slot; (nil, nil) means none.
type ValueSource interface {
	Name() string
	Enabled() bool
	Lookup(ctx context.Context, slot string) ([]string, error)
}

// stored returns values for a slot from the Store and all enabled sources.
func (m *Manager) stored(ctx context.Context, slot string) []found {
	var out []found
	if m.opt.Store != nil {
		if v, err := m.opt.Store.Get(slot); err == nil && v != "" {
			m.redact(v)
			out = append(out, found{Where: "keyring " + slot, Value: v})
		}
	}
	srcs := m.opt.Sources
	if m.protonSv != nil {
		srcs = append(append([]ValueSource{}, srcs...), m.protonSv)
	}
	for _, s := range srcs {
		if !s.Enabled() {
			continue
		}
		vals, err := s.Lookup(ctx, slot)
		if err != nil {
			continue
		}
		for _, v := range vals {
			m.redact(v)
			out = append(out, found{Where: s.Name() + " " + slot, Value: v})
		}
	}
	return out
}

func shortHash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:4])
}

func fullHash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func normFingerprint(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.NewReplacer(":", "", " ", "").Replace(s)
	return strings.TrimPrefix(s, "sha256")
}

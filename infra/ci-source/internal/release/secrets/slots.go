package secrets

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
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
	for _, v := range m.session[slot] {
		m.redact(v)
		out = append(out, found{Where: "typed this session", Value: v})
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

// SetValueOpt is SetValue with a choice: remember=false keeps the value in
// memory for this run only (nothing is written anywhere).
func (m *Manager) SetValueOpt(slot, value string, remember bool) error {
	if remember {
		return m.SetValue(slot, value)
	}
	if !validSlot(slot) {
		return fmt.Errorf("unknown slot %q", slot)
	}
	if value == "" {
		return fmt.Errorf("empty value for %s", slot)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.redact(value)
	m.session[slot] = []string{value}
	m.invalidateLocked(false)
	return nil
}

// PasteKey takes a whole minisign secret key, as the file's text or just its
// base64 line, and uses it for the given signing secret. It returns how many
// characters it kept (the value is never echoed).
func (m *Manager) PasteKey(id ID, text string, remember bool) (int, error) {
	if _, ok := productOf(id); !ok {
		return 0, fmt.Errorf("%s is not a signing key", id)
	}
	key, err := normalizeKeyText(text)
	if err != nil {
		return 0, err
	}
	m.redact(strings.TrimSpace(strings.SplitN(key, "\n", 2)[1]))
	return len(key), m.SetValueOpt(SlotKey(id), key, remember)
}

// PasteKeystore takes an Android keystore as base64 text (whitespace and line
// breaks are ignored) and returns the size of the keystore in bytes.
func (m *Manager) PasteKeystore(b64 string, remember bool) (int, error) {
	data, err := decodeB64(b64)
	if err != nil || len(data) == 0 {
		return 0, errors.New("that is not base64 text; paste the keystore file encoded with base64")
	}
	if len(data) > maxKeystoreFileSize {
		return 0, errors.New("that is too big for a keystore")
	}
	clean := base64.StdEncoding.EncodeToString(data)
	return len(data), m.SetValueOpt(SlotAndroidKeystore, clean, remember)
}

// normalizeKeyText accepts a minisign secret key file's text (comment line
// included or not) or its bare base64 line, and returns the canonical text.
func normalizeKeyText(text string) (string, error) {
	var key string
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "untrusted comment:") {
			continue
		}
		key = strings.Join(strings.Fields(l), "")
	}
	if len(key) != 212 || !strings.HasPrefix(key, "RW") {
		return "", errors.New("that does not look like a minisign secret key (a line of 212 characters starting RW)")
	}
	return "untrusted comment: minisign secret key\n" + key + "\n", nil
}

// ProtonConfig returns the Proton Pass settings.
func (m *Manager) ProtonConfig() ProtonConfig { return m.loadConfig().Proton }

// SetProton saves the Proton Pass settings and uses them from now on.
func (m *Manager) SetProton(pc ProtonConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.loadConfig()
	c.Proton = pc
	m.invalidateLocked(false)
	return m.saveConfig(c)
}

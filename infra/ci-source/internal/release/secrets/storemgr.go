package secrets

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/99designs/keyring"
)

// StoreMode says where remembered values live.
type StoreMode string

const (
	// ModeSystem is the desktop keyring (Secret Service / KWallet), unlocked at login.
	ModeSystem StoreMode = "system"
	// ModeVault is an encrypted file the tool owns, opened with one passphrase.
	ModeVault StoreMode = "vault"
)

// Errors from the store manager.
var (
	ErrLocked            = errors.New("the vault is locked")
	ErrWrongPassphrase   = errors.New("that passphrase is wrong")
	ErrSystemUnavailable = errors.New("no system keyring is available (needs Secret Service or KWallet)")
)

// vaultCheckSlot holds a known value in the vault, so a wrong passphrase is
// noticed when unlocking instead of looking like "nothing is stored".
const vaultCheckSlot = "vault-check"

const vaultCheckValue = "libreserv-release vault"

// StoreOptions configure a StoreManager.
type StoreOptions struct {
	// ConfigDir holds secrets.json, where the choice is saved
	// (default ~/.config/libreserv-release).
	ConfigDir string
	// Service is the keyring service name (default "libreserv-release").
	Service string
	// VaultDir is the vault's folder (default <ConfigDir>/keyring).
	VaultDir string
	// System opens the system keyring (default: Secret Service, then
	// KWallet; never the file backend). Tests replace it.
	System func() (Store, error)
	// Passphrase asks for the vault passphrase when something needs the
	// vault while it is locked (the CLI). Nil: a locked vault just reads as
	// locked (the TUI unlocks up front). Asked once per process; twice when
	// the vault is being created (to confirm), and again only after a wrong
	// passphrase (up to three tries).
	Passphrase func(prompt string) (string, error)
	// OnSecret receives the passphrase so output filters can hide it.
	OnSecret func(string)
	// Timeout bounds every system keyring call (default 15s): a locked
	// keyring waiting on an unlock dialog must not hang the tool.
	Timeout time.Duration
}

// StoreManager is the Store the tool uses: it routes to the system keyring
// or to the passphrase vault, according to the user's saved choice, and can
// switch between them (moving the values). The vault passphrase lives in
// memory for this process only.
type StoreManager struct {
	o StoreOptions

	mu          sync.Mutex
	defaultMode StoreMode // decided once per process when nothing is saved
	system      Store
	sysErr      error
	sysTried    bool
	vault       Store
	pass        string
	promptDone  bool
}

// NewStoreManager fills in defaults. It opens nothing.
func NewStoreManager(o StoreOptions) *StoreManager {
	if o.ConfigDir == "" {
		o.ConfigDir = DefaultConfigDir()
	}
	if o.Service == "" {
		o.Service = "libreserv-release"
	}
	if o.VaultDir == "" {
		o.VaultDir = filepath.Join(o.ConfigDir, "keyring")
	}
	if o.Timeout == 0 {
		o.Timeout = 15 * time.Second
	}
	if o.System == nil {
		svc := o.Service
		o.System = func() (Store, error) {
			return NewKeyringStore(KeyringConfig{Service: svc,
				Backends: []keyring.BackendType{keyring.SecretServiceBackend, keyring.KWalletBackend}})
		}
	}
	return &StoreManager{o: o}
}

// boundedCall runs f, giving up after d.
func boundedCall[T any](d time.Duration, f func() (T, error)) (T, error) {
	type r struct {
		v   T
		err error
	}
	ch := make(chan r, 1)
	go func() { v, err := f(); ch <- r{v, err} }()
	select {
	case x := <-ch:
		return x.v, x.err
	case <-time.After(d):
		var zero T
		return zero, errors.New("the keyring did not answer in time (is it locked?)")
	}
}

// ---- state

// Saved returns the user's explicit choice ("" when none was made).
func (s *StoreManager) Saved() StoreMode {
	switch StoreMode(loadConfigIn(s.o.ConfigDir).Store) {
	case ModeSystem:
		return ModeSystem
	case ModeVault:
		return ModeVault
	}
	return ""
}

// Mode is the active mode: the saved choice, else system when a system
// keyring answers, else vault. The default is worked out once per process
// and may take a moment (it probes the keyring).
func (s *StoreManager) Mode() StoreMode {
	if m := s.Saved(); m != "" {
		return m
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.defaultMode == "" {
		if s.openSystemLocked() == nil {
			s.defaultMode = ModeSystem
		} else {
			s.defaultMode = ModeVault
		}
	}
	return s.defaultMode
}

// SystemAvailable reports whether a system keyring answers, and why not.
func (s *StoreManager) SystemAvailable() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.openSystemLocked()
	return err == nil, err
}

func (s *StoreManager) openSystemLocked() error {
	if s.system != nil {
		return nil
	}
	if s.sysTried {
		return s.sysErr
	}
	s.sysTried = true
	st, err := boundedCall(s.o.Timeout, func() (Store, error) { return s.o.System() })
	if err != nil {
		s.sysErr = fmt.Errorf("%w: %v", ErrSystemUnavailable, err)
		return s.sysErr
	}
	s.system = st
	return nil
}

// VaultExists reports whether a vault file folder already holds values.
func (s *StoreManager) VaultExists() bool {
	ents, err := os.ReadDir(s.o.VaultDir)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if !e.IsDir() && e.Name()[0] != '.' {
			return true
		}
	}
	return false
}

// VaultDir is where the vault file lives.
func (s *StoreManager) VaultDir() string { return s.o.VaultDir }

// Unlocked reports whether values can be read right now: the vault has its
// passphrase, or the system keyring answered.
func (s *StoreManager) Unlocked() bool {
	mode := s.Mode()
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode == ModeVault {
		return s.vault != nil
	}
	return s.system != nil
}

// NeedsUnlock is true when the vault is the active store and still locked.
func (s *StoreManager) NeedsUnlock() bool {
	return s.Mode() == ModeVault && !s.Unlocked()
}

// ---- vault

func (s *StoreManager) newVaultStore(dir, pass string) (Store, error) {
	return NewKeyringStore(KeyringConfig{Service: s.o.Service, FileDir: dir,
		Backends:   []keyring.BackendType{keyring.FileBackend},
		Passphrase: func(string) (string, error) { return pass, nil }})
}

// Unlock opens the vault with its passphrase. When there is no vault yet, it
// is created with this passphrase.
func (s *StoreManager) Unlock(pass string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.unlockLocked(pass)
}

func (s *StoreManager) unlockLocked(pass string) error {
	if s.vault != nil {
		return nil
	}
	if pass == "" {
		return ErrWrongPassphrase
	}
	exists := s.VaultExists()
	st, err := s.newVaultStore(s.o.VaultDir, pass)
	if err != nil {
		return err
	}
	if exists {
		if err := verifyVault(st); err != nil {
			return err
		}
	}
	if err := st.Set(vaultCheckSlot, vaultCheckValue); err != nil {
		return err
	}
	s.vault, s.pass = st, pass
	if s.o.OnSecret != nil {
		s.o.OnSecret(pass)
	}
	return nil
}

// verifyVault proves the passphrase by decrypting the check value, or (for a
// vault written before there was one) any stored value.
func verifyVault(st Store) error {
	v, err := st.Get(vaultCheckSlot)
	switch {
	case err == nil:
		if v != vaultCheckValue {
			return ErrWrongPassphrase
		}
		return nil
	case errors.Is(err, ErrNotFound):
		keys, kerr := st.Keys()
		if kerr != nil || len(keys) == 0 {
			return nil
		}
		for _, k := range keys {
			if _, err := st.Get(k); err == nil {
				return nil
			}
			break
		}
		return ErrWrongPassphrase
	}
	return ErrWrongPassphrase
}

// Lock forgets the passphrase.
func (s *StoreManager) Lock() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.vault, s.pass = nil, ""
}

// active returns the store values are read from and written to.
func (s *StoreManager) active() (Store, error) {
	mode := s.Mode()
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode == ModeSystem {
		if err := s.openSystemLocked(); err != nil {
			return nil, err
		}
		return s.system, nil
	}
	if s.vault == nil {
		s.askPassphraseLocked()
	}
	if s.vault == nil {
		return nil, ErrLocked
	}
	return s.vault, nil
}

// askPassphraseLocked is the CLI path: ask once per process (twice to
// confirm a new vault), and again only after a wrong passphrase.
func (s *StoreManager) askPassphraseLocked() {
	if s.o.Passphrase == nil || s.promptDone {
		return
	}
	s.promptDone = true
	creating := !s.VaultExists()
	for try := 0; try < 3; try++ {
		prompt := "Enter the vault passphrase"
		if creating {
			prompt = "Choose a passphrase for the new vault"
		}
		p, err := s.o.Passphrase(prompt)
		if err != nil || p == "" {
			return
		}
		if creating {
			again, err := s.o.Passphrase("Type the passphrase again to confirm")
			if err != nil || again != p {
				return
			}
		}
		if err := s.unlockLocked(p); err == nil || !errors.Is(err, ErrWrongPassphrase) {
			return
		}
	}
}

// ---- Store interface

func (s *StoreManager) Get(slot string) (string, error) {
	st, err := s.active()
	if err != nil {
		return "", ErrNotFound
	}
	v, err := boundedCall(s.o.Timeout, func() (string, error) { return st.Get(slot) })
	if err != nil && !errors.Is(err, ErrNotFound) {
		return "", ErrNotFound
	}
	return v, err
}

func (s *StoreManager) Set(slot, value string) error {
	st, err := s.active()
	if err != nil {
		return err
	}
	_, err = boundedCall(s.o.Timeout, func() (struct{}, error) { return struct{}{}, st.Set(slot, value) })
	return err
}

func (s *StoreManager) Remove(slot string) error {
	st, err := s.active()
	if err != nil {
		if errors.Is(err, ErrLocked) || errors.Is(err, ErrSystemUnavailable) {
			return err
		}
		return nil
	}
	_, err = boundedCall(s.o.Timeout, func() (struct{}, error) { return struct{}{}, st.Remove(slot) })
	return err
}

func (s *StoreManager) Keys() ([]string, error) {
	st, err := s.active()
	if err != nil {
		return nil, err
	}
	keys, err := boundedCall(s.o.Timeout, func() ([]string, error) { return st.Keys() })
	out := keys[:0:0]
	for _, k := range keys {
		if k != vaultCheckSlot {
			out = append(out, k)
		}
	}
	return out, err
}

// Backend names where values really live: "secret-service", "kwallet",
// "file" (the vault), or "none".
func (s *StoreManager) Backend() string {
	mode := s.Mode()
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode == ModeVault {
		return "file"
	}
	if s.openSystemLocked() != nil {
		return "none"
	}
	return s.system.Backend()
}

// ---- switching and passphrase change

func allKnownSlots(st Store) []string {
	seen := map[string]bool{}
	var out []string
	for _, si := range allSlots() {
		seen[si.Slot] = true
		out = append(out, si.Slot)
	}
	if keys, err := st.Keys(); err == nil {
		sort.Strings(keys)
		for _, k := range keys {
			if !seen[k] && k != vaultCheckSlot {
				out = append(out, k)
			}
		}
	}
	return out
}

// SwitchTo makes `to` the active store and moves every remembered value
// there: copied first, checked by reading it back, and only then deleted from
// the old store. Moving into or out of the vault needs its passphrase
// (unless already unlocked); a new vault is created with it. Returns how many
// values moved. On any error nothing is deleted and the choice is unchanged.
func (s *StoreManager) SwitchTo(to StoreMode, vaultPass string) (int, error) {
	if to != ModeSystem && to != ModeVault {
		return 0, fmt.Errorf("unknown store %q (use system or vault)", to)
	}
	from := s.Mode()
	s.mu.Lock()
	defer s.mu.Unlock()
	if to == ModeSystem {
		if err := s.openSystemLocked(); err != nil {
			return 0, err
		}
	}
	if from == ModeVault || to == ModeVault {
		if s.vault == nil {
			if vaultPass == "" {
				return 0, ErrLocked
			}
			if err := s.unlockLocked(vaultPass); err != nil {
				return 0, err
			}
		}
	}
	if from == to {
		return 0, s.saveChoiceLocked(to)
	}
	src, dst := s.system, s.vault
	if from == ModeVault {
		src, dst = s.vault, s.system
	}
	if src == nil {
		// The old store is the system keyring and it is not reachable:
		// there is nothing to read, so only the choice changes.
		if from == ModeSystem && s.openSystemLocked() != nil {
			return 0, s.saveChoiceLocked(to)
		}
	}
	moved := 0
	var copied []string
	if src != nil {
		for _, slot := range allKnownSlots(src) {
			v, err := src.Get(slot)
			if errors.Is(err, ErrNotFound) {
				continue
			}
			if err != nil {
				return moved, fmt.Errorf("read %s: %w", slot, err)
			}
			if err := dst.Set(slot, v); err != nil {
				return moved, fmt.Errorf("write %s: %w", slot, err)
			}
			back, err := dst.Get(slot)
			if err != nil || subtle.ConstantTimeCompare([]byte(back), []byte(v)) != 1 {
				return moved, fmt.Errorf("could not read %s back from the new store", slot)
			}
			copied = append(copied, slot)
			moved++
		}
		for _, slot := range copied {
			if err := src.Remove(slot); err != nil {
				return moved, fmt.Errorf("remove %s from the old store: %w", slot, err)
			}
		}
	}
	if from == ModeVault {
		_ = s.vault.Remove(vaultCheckSlot)
		s.vault, s.pass = nil, ""
	}
	s.defaultMode = ""
	return moved, s.saveChoiceLocked(to)
}

func (s *StoreManager) saveChoiceLocked(m StoreMode) error {
	c := loadConfigIn(s.o.ConfigDir)
	c.Store = string(m)
	return saveConfigIn(s.o.ConfigDir, c)
}

// ChangePassphrase re-encrypts the vault with a new passphrase. The old one
// must match the one in use. The new vault is built beside the old one and
// swapped in only when every value reads back.
func (s *StoreManager) ChangePassphrase(oldPass, newPass string) error {
	if newPass == "" {
		return errors.New("the new passphrase is empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.vault == nil {
		return ErrLocked
	}
	if subtle.ConstantTimeCompare([]byte(oldPass), []byte(s.pass)) != 1 {
		return ErrWrongPassphrase
	}
	tmp := s.o.VaultDir + ".new"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	fresh, err := s.newVaultStore(tmp, newPass)
	if err != nil {
		return err
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	vals := map[string]string{}
	for _, slot := range allKnownSlots(s.vault) {
		v, err := s.vault.Get(slot)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			cleanup()
			return fmt.Errorf("read %s: %w", slot, err)
		}
		vals[slot] = v
	}
	vals[vaultCheckSlot] = vaultCheckValue
	for slot, v := range vals {
		if err := fresh.Set(slot, v); err != nil {
			cleanup()
			return fmt.Errorf("write %s: %w", slot, err)
		}
	}
	// Read every value back with the new passphrase.
	check, err := s.newVaultStore(tmp, newPass)
	if err != nil {
		cleanup()
		return err
	}
	for slot, v := range vals {
		if got, err := check.Get(slot); err != nil || got != v {
			cleanup()
			return fmt.Errorf("could not read %s back with the new passphrase", slot)
		}
	}
	old := s.o.VaultDir + ".old"
	_ = os.RemoveAll(old)
	if err := os.Rename(s.o.VaultDir, old); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, s.o.VaultDir); err != nil {
		_ = os.Rename(old, s.o.VaultDir)
		cleanup()
		return err
	}
	_ = os.RemoveAll(old)
	live, err := s.newVaultStore(s.o.VaultDir, newPass)
	if err != nil {
		return err
	}
	s.vault, s.pass = live, newPass
	if s.o.OnSecret != nil {
		s.o.OnSecret(newPass)
	}
	return nil
}

package secrets

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/99designs/keyring"
)

// ErrNotFound is returned by Store.Get when a slot has no value.
var ErrNotFound = errors.New("secret not set")

// Store keeps pasted secrets. The real implementation is the OS keyring with
// an encrypted-file fallback; tests use MemStore.
type Store interface {
	Get(slot string) (string, error)
	Set(slot, value string) error
	Remove(slot string) error
	Keys() ([]string, error)
	// Backend names where values really live ("secret-service", "file", ...).
	Backend() string
}

// MemStore is an in-memory Store.
type MemStore struct {
	mu sync.Mutex
	m  map[string]string
}

func NewMemStore() *MemStore { return &MemStore{m: map[string]string{}} }

func (s *MemStore) Get(slot string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[slot]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

func (s *MemStore) Set(slot, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[slot] = value
	return nil
}

func (s *MemStore) Remove(slot string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, slot)
	return nil
}

func (s *MemStore) Keys() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

func (s *MemStore) Backend() string { return "memory" }

// KeyringConfig configures NewKeyringStore.
type KeyringConfig struct {
	// Service is the keyring service name (default "libreserv-release").
	Service string
	// FileDir is where the encrypted fallback file lives
	// (default ~/.config/libreserv-release/keyring).
	FileDir string
	// Passphrase unlocks the file fallback. Called lazily, only when the
	// file backend is actually used (no Secret Service available).
	Passphrase func(prompt string) (string, error)
	// Backends restricts the backends tried (tests: file only). Empty means
	// Secret Service, KWallet, then the encrypted file.
	Backends []keyring.BackendType
}

type keyringStore struct {
	ring    keyring.Keyring
	backend string
}

// NewKeyringStore opens the OS keyring (Secret Service / KWallet), falling
// back to a passphrase-encrypted file when none is reachable.
func NewKeyringStore(c KeyringConfig) (Store, error) {
	if c.Service == "" {
		c.Service = "libreserv-release"
	}
	if c.FileDir == "" {
		home, _ := os.UserHomeDir()
		c.FileDir = filepath.Join(home, ".config", "libreserv-release", "keyring")
	}
	backends := c.Backends
	if len(backends) == 0 {
		backends = []keyring.BackendType{keyring.SecretServiceBackend, keyring.KWalletBackend, keyring.FileBackend}
	}
	cfg := keyring.Config{
		ServiceName:             c.Service,
		FileDir:                 c.FileDir,
		KWalletAppID:            c.Service,
		KWalletFolder:           c.Service,
		LibSecretCollectionName: "login",
	}
	if c.Passphrase != nil {
		cfg.FilePasswordFunc = keyring.PromptFunc(c.Passphrase)
	} else {
		cfg.FilePasswordFunc = func(string) (string, error) {
			return "", errors.New("no passphrase available for the encrypted keyring file")
		}
	}
	// One backend at a time, so the store knows which one it really got.
	var lastErr error
	for _, b := range backends {
		cfg.AllowedBackends = []keyring.BackendType{b}
		ring, err := keyring.Open(cfg)
		if err == nil {
			return &keyringStore{ring: ring, backend: string(b)}, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("open keyring: %w", lastErr)
}

func (s *keyringStore) Get(slot string) (string, error) {
	it, err := s.ring.Get(slot)
	if errors.Is(err, keyring.ErrKeyNotFound) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return string(it.Data), nil
}

func (s *keyringStore) Set(slot, value string) error {
	return s.ring.Set(keyring.Item{Key: slot, Data: []byte(value), Label: "Sol release: " + slot})
}

func (s *keyringStore) Remove(slot string) error {
	err := s.ring.Remove(slot)
	if errors.Is(err, keyring.ErrKeyNotFound) {
		return nil
	}
	return err
}

func (s *keyringStore) Keys() ([]string, error) { return s.ring.Keys() }

func (s *keyringStore) Backend() string { return s.backend }

package store

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type Store interface {
	// Put stores bytes and returns how many were written plus which backend holds them
	// ("local" or "b2"). Callers should persist that backend on backup_objects.
	Put(accountID, deviceID, relPath string, r io.Reader) (written int64, backend string, err error)
	Get(accountID, deviceID, relPath string) (io.ReadCloser, error)
	Delete(accountID, deviceID, relPath string) error
	DeleteAccount(accountID string) error
}

type Local struct {
	Root string
}

func NewLocal(root string) (*Local, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil {
		return nil, err
	}
	_ = os.Chmod(abs, 0o700)
	return &Local{Root: abs}, nil
}

func opaqueIDOK(id string) bool {
	if id == "" || strings.ContainsRune(id, 0) {
		return false
	}
	if strings.ContainsAny(id, `/\`) || strings.Contains(id, "..") {
		return false
	}
	return true
}

func (s *Local) path(accountID, deviceID, relPath string) (string, error) {
	if !opaqueIDOK(accountID) || !opaqueIDOK(deviceID) {
		return "", fmt.Errorf("that file path is not allowed")
	}
	if strings.ContainsRune(relPath, 0) || strings.Contains(relPath, "..") || strings.ContainsAny(relPath, `\\`) {
		return "", fmt.Errorf("that file path is not allowed")
	}
	clean := filepath.Clean("/" + strings.ReplaceAll(relPath, "\\", "/"))
	clean = strings.TrimPrefix(clean, "/")
	if clean == "" || strings.Contains(clean, "..") {
		return "", fmt.Errorf("that file path is not allowed")
	}
	joined := filepath.Join(s.Root, accountID, deviceID, clean)
	absJoined, err := filepath.Abs(joined)
	if err != nil {
		return "", fmt.Errorf("that file path is not allowed")
	}
	rel, err := filepath.Rel(s.Root, absJoined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("that file path is not allowed")
	}
	return absJoined, nil
}

func (s *Local) Put(accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	p, err := s.path(accountID, deviceID, relPath)
	if err != nil {
		return 0, BackendLocal, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return 0, BackendLocal, err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, BackendLocal, err
	}
	defer f.Close()
	_ = os.Chmod(p, 0o600)
	n, err := io.Copy(f, r)
	return n, BackendLocal, err
}

func (s *Local) Get(accountID, deviceID, relPath string) (io.ReadCloser, error) {
	p, err := s.path(accountID, deviceID, relPath)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (s *Local) Delete(accountID, deviceID, relPath string) error {
	p, err := s.path(accountID, deviceID, relPath)
	if err != nil {
		return err
	}
	return os.Remove(p)
}

func (s *Local) DeleteAccount(accountID string) error {
	if !opaqueIDOK(accountID) {
		return fmt.Errorf("that file path is not allowed")
	}
	return os.RemoveAll(filepath.Join(s.Root, accountID))
}

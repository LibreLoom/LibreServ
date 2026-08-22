package store

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type Store interface {
	Put(accountID, deviceID, relPath string, r io.Reader) (int64, error)
	Get(accountID, deviceID, relPath string) (io.ReadCloser, error)
	Delete(accountID, deviceID, relPath string) error
}

type Local struct {
	Root string
}

func NewLocal(root string) (*Local, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &Local{Root: root}, nil
}

func (s *Local) path(accountID, deviceID, relPath string) (string, error) {
	clean := filepath.Clean("/" + strings.ReplaceAll(relPath, "\\", "/"))
	clean = strings.TrimPrefix(clean, "/")
	if clean == "" || strings.Contains(clean, "..") {
		return "", fmt.Errorf("that file path is not allowed")
	}
	return filepath.Join(s.Root, accountID, deviceID, clean), nil
}

func (s *Local) Put(accountID, deviceID, relPath string, r io.Reader) (int64, error) {
	p, err := s.path(accountID, deviceID, relPath)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return 0, err
	}
	f, err := os.Create(p)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return io.Copy(f, r)
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

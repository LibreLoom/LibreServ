package network

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
)

func ownedDirectory(path string, mode os.FileMode) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&mode != 0 {
		return errors.New("remote access directory is not private and owned by Sol")
	}
	return nil
}

func protectedAncestry(path string) error {
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || (stat.Uid != 0 && stat.Uid != uint32(os.Geteuid())) || info.Mode().Perm()&0022 != 0 {
			return errors.New("remote access path has an unprotected ancestor")
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil
		}
	}
}

// BindTailscaleSocket creates an exclusive target that no later process reuses.
func BindTailscaleSocket(data string) (*net.UnixListener, string, error) {
	if !filepath.IsAbs(data) {
		return nil, "", errors.New("remote access data path must be absolute")
	}
	if err := protectedAncestry(data); err != nil {
		return nil, "", err
	}
	if err := ownedDirectory(data, 0022); err != nil {
		return nil, "", err
	}
	parent := filepath.Join(data, "ts")
	if err := os.Mkdir(parent, 0700); err != nil && !os.IsExist(err) {
		return nil, "", err
	}
	if err := ownedDirectory(parent, 0077); err != nil {
		return nil, "", err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, "", err
	}
	generation := filepath.Join(parent, hex.EncodeToString(random[:]))
	socket := filepath.Join(generation, "s")
	if len(socket) >= 108 {
		return nil, "", errors.New("remote access socket path is too long")
	}
	if err := os.Mkdir(generation, 0700); err != nil {
		return nil, "", err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return nil, "", err
	}
	if err := os.Chmod(socket, 0600); err != nil {
		_ = listener.Close()
		return nil, "", err
	}
	return listener, socket, nil
}

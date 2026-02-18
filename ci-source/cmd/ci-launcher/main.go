package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

func main() {
	exePath, _ := os.Executable()
	exeDir := filepath.Dir(exePath)
	binDir := filepath.Join(exeDir, "ci-source", "bin")

	var ciBin string

	switch runtime.GOOS {
	case "linux":
		ciBin = filepath.Join(binDir, "ci-linux-amd64")
	case "darwin":
		switch runtime.GOARCH {
		case "arm64":
			ciBin = filepath.Join(binDir, "ci-darwin-arm64")
		default:
			ciBin = filepath.Join(binDir, "ci-darwin-amd64")
		}
	case "windows":
		ciBin = filepath.Join(binDir, "ci-windows-amd64.exe")
	default:
		fmt.Fprintf(os.Stderr, "Unsupported platform: %s/%s\n", runtime.GOOS, runtime.GOARCH)
		os.Exit(1)
	}

	if _, err := os.Stat(ciBin); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "CI binary not found: %s\n", ciBin)
		os.Exit(1)
	}

	cmd := exec.Command(ciBin, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Run()
}

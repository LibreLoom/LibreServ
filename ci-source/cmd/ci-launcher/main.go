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
	sourceDir := filepath.Join(exeDir, "ci-source")

	var binName string

	switch runtime.GOOS {
	case "windows":
		binName = fmt.Sprintf("ci-%s-%s.exe", runtime.GOOS, runtime.GOARCH)
	default:
		binName = fmt.Sprintf("ci-%s-%s", runtime.GOOS, runtime.GOARCH)
	}

	ciBin := filepath.Join(binDir, binName)

	if _, err := os.Stat(ciBin); os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "CI binary not found, building for %s/%s...\n", runtime.GOOS, runtime.GOARCH)

		buildCmd := exec.Command("go", "build", "-o", filepath.Join("bin", binName), "./cmd/ci")
		buildCmd.Dir = sourceDir
		buildCmd.Stdout = os.Stderr
		buildCmd.Stderr = os.Stderr

		if err := buildCmd.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "\nBuild failed: %v\n", err)
			os.Exit(1)
		}

		fmt.Fprintf(os.Stderr, "Build complete!\n\n")
	}

	cmd := exec.Command(ciBin, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	cmd.Run()
}

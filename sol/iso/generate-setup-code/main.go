package main

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
)

var noAmbigChars = []rune("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

func main() {
	code := make([]rune, 6)
	for i := range code {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(noAmbigChars))))
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to generate setup code: %v\n", err)
			os.Exit(1)
		}
		code[i] = noAmbigChars[n.Int64()]
	}

	outputPath := "/etc/libreserv/setup-code"
	if len(os.Args) > 1 {
		outputPath = os.Args[1]
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0750); err != nil {
		fmt.Fprintf(os.Stderr, "failed to create directory: %v\n", err)
		os.Exit(1)
	}

	// Match install.sh (chmod 640): setup code must not be world-readable.
	if err := os.WriteFile(outputPath, []byte(string(code)+"\n"), 0o640); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write setup code: %v\n", err)
		os.Exit(1)
	}
	// WriteFile only applies mode on create; force 0640 if the path already existed.
	if err := os.Chmod(outputPath, 0o640); err != nil {
		fmt.Fprintf(os.Stderr, "failed to set setup code permissions: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(code))
}

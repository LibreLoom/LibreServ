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
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(noAmbigChars))))
		code[i] = noAmbigChars[n.Int64()]
	}

	outputPath := "/etc/libreserv/setup-code"
	if len(os.Args) > 1 {
		outputPath = os.Args[1]
	}

	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		fmt.Fprintf(os.Stderr, "failed to create directory: %v\n", err)
		os.Exit(1)
	}

	if err := os.WriteFile(outputPath, []byte(string(code)+"\n"), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write setup code: %v\n", err)
		os.Exit(1)
	}

	fmt.Println(string(code))
}

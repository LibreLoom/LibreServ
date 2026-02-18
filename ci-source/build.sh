#!/bin/sh
set -e
cd "$(dirname "$0")"

echo "Building CI binaries for all platforms..."

# Linux
echo "  Linux amd64..."
GOOS=linux GOARCH=amd64 go build -o bin/ci-linux-amd64 ./cmd/ci

echo "  Linux arm64..."
GOOS=linux GOARCH=arm64 go build -o bin/ci-linux-arm64 ./cmd/ci

# macOS
echo "  macOS amd64..."
GOOS=darwin GOARCH=amd64 go build -o bin/ci-darwin-amd64 ./cmd/ci

echo "  macOS arm64..."
GOOS=darwin GOARCH=arm64 go build -o bin/ci-darwin-arm64 ./cmd/ci

# FreeBSD
echo "  FreeBSD amd64..."
GOOS=freebsd GOARCH=amd64 go build -o bin/ci-freebsd-amd64 ./cmd/ci

echo "  FreeBSD arm64..."
GOOS=freebsd GOARCH=arm64 go build -o bin/ci-freebsd-arm64 ./cmd/ci

# Windows
echo "  Windows amd64..."
GOOS=windows GOARCH=amd64 go build -o bin/ci-windows-amd64.exe ./cmd/ci

echo "  Windows arm64..."
GOOS=windows GOARCH=arm64 go build -o bin/ci-windows-arm64.exe ./cmd/ci

# Build Windows launcher
echo "Building Windows launcher..."
GOOS=windows GOARCH=amd64 go build -o ../ci.exe ./cmd/ci-launcher

echo ""
echo "Done! Binaries in ci-source/bin/"
ls -la bin/

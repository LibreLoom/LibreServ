#!/bin/sh
set -e
cd "$(dirname "$0")"

echo "Building CI for all platforms..."

# Build main CI binary for all platforms
echo "  Linux amd64..."
GOOS=linux GOARCH=amd64 go build -o bin/ci-linux-amd64 ./cmd/ci

echo "  macOS amd64..."
GOOS=darwin GOARCH=amd64 go build -o bin/ci-darwin-amd64 ./cmd/ci

echo "  macOS arm64..."
GOOS=darwin GOARCH=arm64 go build -o bin/ci-darwin-arm64 ./cmd/ci

echo "  Windows amd64..."
GOOS=windows GOARCH=amd64 go build -o bin/ci-windows-amd64.exe ./cmd/ci

# Build launchers for all platforms
echo "  Launcher Linux..."
GOOS=linux GOARCH=amd64 go build -o bin/launcher-linux-amd64 ./cmd/ci-launcher

echo "  Launcher macOS amd64..."
GOOS=darwin GOARCH=amd64 go build -o bin/launcher-darwin-amd64 ./cmd/ci-launcher

echo "  Launcher macOS arm64..."
GOOS=darwin GOARCH=arm64 go build -o bin/launcher-darwin-arm64 ./cmd/ci-launcher

echo "  Launcher Windows..."
GOOS=windows GOARCH=amd64 go build -o bin/launcher-windows-amd64.exe ./cmd/ci-launcher

# Install to root
echo "Installing to root..."

# Determine current platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  linux)
    PLATFORM="linux-amd64"
    ;;
  darwin)
    if [ "$ARCH" = "arm64" ]; then
      PLATFORM="darwin-arm64"
    else
      PLATFORM="darwin-amd64"
    fi
    ;;
  *)
    echo "Unknown platform: $OS $ARCH"
    exit 1
    ;;
esac

# Copy Unix launcher as ./ci
cp "bin/launcher-$PLATFORM" "../ci"
chmod +x "../ci"

# Copy Windows launcher (for people who sync repo to Windows)
cp "bin/launcher-windows-amd64.exe" "../ci.exe"
chmod +x "../ci.exe" 2>/dev/null || true

echo "Done! Installed ./ci ($PLATFORM)"
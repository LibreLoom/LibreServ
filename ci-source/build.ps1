# Build CI binaries for all platforms
$ErrorActionPreference = "Stop"

Push-Location
try {
    Set-Location $PSScriptRoot

    Write-Host "Building CI binaries for all platforms..."

    # Linux
    Write-Host "  Linux amd64..."
    $env:GOOS = "linux"; $env:GOARCH = "amd64"
    go build -o bin/ci-linux-amd64 ./cmd/ci

    Write-Host "  Linux arm64..."
    $env:GOOS = "linux"; $env:GOARCH = "arm64"
    go build -o bin/ci-linux-arm64 ./cmd/ci

    # macOS
    Write-Host "  macOS amd64..."
    $env:GOOS = "darwin"; $env:GOARCH = "amd64"
    go build -o bin/ci-darwin-amd64 ./cmd/ci

    Write-Host "  macOS arm64..."
    $env:GOOS = "darwin"; $env:GOARCH = "arm64"
    go build -o bin/ci-darwin-arm64 ./cmd/ci

    # FreeBSD
    Write-Host "  FreeBSD amd64..."
    $env:GOOS = "freebsd"; $env:GOARCH = "amd64"
    go build -o bin/ci-freebsd-amd64 ./cmd/ci

    Write-Host "  FreeBSD arm64..."
    $env:GOOS = "freebsd"; $env:GOARCH = "arm64"
    go build -o bin/ci-freebsd-arm64 ./cmd/ci

    # Windows
    Write-Host "  Windows amd64..."
    $env:GOOS = "windows"; $env:GOARCH = "amd64"
    go build -o bin/ci-windows-amd64.exe ./cmd/ci

    Write-Host "  Windows arm64..."
    $env:GOOS = "windows"; $env:GOARCH = "arm64"
    go build -o bin/ci-windows-arm64.exe ./cmd/ci

    # Reset environment
    $env:GOOS = ""; $env:GOARCH = ""

    # Build Windows launcher
    Write-Host "Building Windows launcher..."
    Set-Location ..
    go build -o ci.exe ./ci-source/cmd/ci-launcher

    Write-Host ""
    Write-Host "Done! Binaries in ci-source/bin/"
    Get-ChildItem ci-source/bin
}
finally {
    Pop-Location
}

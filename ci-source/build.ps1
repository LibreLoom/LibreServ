# Build CI for all platforms
$ErrorActionPreference = "Stop"

Write-Host "Building CI for all platforms..."

# Build main CI binary for all platforms
Write-Host "  Linux amd64..."
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -o bin/ci-linux-amd64 .\cmd\ci

Write-Host "  macOS amd64..."
$env:GOOS = "darwin"
$env:GOARCH = "amd64"
go build -o bin/ci-darwin-amd64 .\cmd\ci

Write-Host "  macOS arm64..."
$env:GOOS = "darwin"
$env:GOARCH = "arm64"
go build -o bin\ci-darwin-arm64 .\cmd\ci

Write-Host "  Windows amd64..."
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -o bin\ci-windows-amd64.exe .\cmd\ci

# Build launchers for all platforms
Write-Host "  Launcher Linux..."
$env:GOOS = "linux"
$env:GOARCH = "amd64"
go build -o bin\launcher-linux-amd64 .\cmd\ci-launcher

Write-Host "  Launcher macOS amd64..."
$env:GOOS = "darwin"
$env:GOARCH = "amd64"
go build -o bin\launcher-darwin-amd64 .\cmd\ci-launcher

Write-Host "  Launcher macOS arm64..."
$env:GOOS = "darwin"
$env:GOARCH = "arm64"
go build -o bin\launcher-darwin-arm64 .\cmd\ci-launcher

Write-Host "  Launcher Windows..."
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -o bin\launcher-windows-amd64.exe .\cmd\ci-launcher

# Reset Go env
$env:GOOS = ""
$env:GOARCH = ""

# Install to root
Write-Host "Installing to root..."

# Determine current platform
$os = $env:OS
$arch = $env:PROCESSOR_ARCHITECTURE

if ($os -eq "Windows_NT") {
    $platform = "windows-amd64"
} else {
    Write-Host "Unknown platform"
    exit 1
}

# Copy Windows launcher as ./ci.exe
Copy-Item "bin\launcher-windows-amd64.exe" "..\ci.exe"

# Copy Unix launcher (for WSL or people who dual-boot)
Copy-Item "bin\launcher-linux-amd64" "..\ci-unix"
Set-ItemProperty -Path "..\ci-unix" -Name IsReadOnly -Value $false
# Actually, for Windows we probably just want ci.exe - let's make ci point to the Unix one for WSL detection

Write-Host "Done! Installed ./ci.exe ($platform)"
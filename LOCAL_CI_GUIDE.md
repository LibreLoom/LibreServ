# Local CI Testing Guide

Tired of waiting for slow Gitea runners? Test your changes locally before pushing!

## 🚀 Quick Start

### Option 1: Local CI Script (Easiest)

```bash
# From repo root
./scripts/local-ci.sh

# Test specific groups
./scripts/local-ci.sh backend      # Go tests only
./scripts/local-ci.sh frontend     # Frontend tests only
./scripts/local-ci.sh security     # Security scans only
./scripts/local-ci.sh coverage     # Coverage report
./scripts/local-ci.sh docker       # Docker build test
./scripts/local-ci.sh help         # Show all options
```

### Option 2: Make Commands

```bash
cd server/backend

# Basic tests
make test              # Run all tests
make test-race         # Run with race detector
make test-coverage     # Generate coverage report
make lint              # Format check + go vet

# Security scans (requires tools installed)
make govulncheck       # Vulnerability check
make gosec             # Security scanner
make staticcheck       # Static analysis
make security          # Run all security checks

# CI shortcuts
make ci-local          # Run backend CI locally
make ci-all            # Run all CI tests
```

## 🛠️ Installing Required Tools

### Essential (for basic testing)
```bash
# Go (should already be installed)
go version

# Node.js (for frontend)
npm --version
```

### Security Tools (optional but recommended)
```bash
# Install govulncheck
go install golang.org/x/vuln/cmd/govulncheck@latest

# Install gosec
go install github.com/securego/gosec/v2/cmd/gosec@latest

# Install staticcheck
go install honnef.co/go/tools/cmd/staticcheck@latest

# Verify installations
which govulncheck gosec staticcheck
```

## 🎯 Testing Specific Scenarios

### Before Committing (Quick Check)
```bash
# From server/backend directory
make lint && make test
```

### Before Pushing (Full Check)
```bash
# From repo root
./scripts/local-ci.sh

# Or from server/backend
make ci-all
```

### Debugging Race Conditions
```bash
cd server/backend
make test-race

# Or specific packages
go test -race -v ./internal/jobqueue/...
```

### Checking Test Coverage
```bash
cd server/backend
make test-coverage

# Open coverage.html in browser
open coverage.html  # macOS
xdg-open coverage.html  # Linux
```

### Security Scanning
```bash
cd server/backend

# Install tools first (one-time)
go install golang.org/x/vuln/cmd/govulncheck@latest
go install github.com/securego/gosec/v2/cmd/gosec@latest
go install honnef.co/go/tools/cmd/staticcheck@latest

# Run security checks
make security
```

## 🐳 Testing Docker Builds

```bash
# From repo root
docker build -t libreserv:local-test .

# Test the image
docker run -p 8080:8080 libreserv:local-test

# Or use the shortcut
make ci-docker
```

## 🔄 Advanced: Using Act (GitHub Actions Local Runner)

Want to run the actual workflow files locally?

### Install Act
```bash
# macOS
brew install act

# Linux
curl https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash

# Verify
act --version
```

### Run Workflows Locally
```bash
# List available workflows
act -l

# Run the CI workflow
act -j go

# Run with verbose output
act -v -j go

# Run specific job
act -j frontend

# Use larger runner (more like Gitea)
act -P ubuntu-latest=nektos/act-environments-ubuntu:18.04 -j go
```

**Note:** Act uses GitHub Actions syntax, but most Gitea workflows are compatible since they use the same syntax.

## 🏃 Advanced: Running Gitea Runner Locally

Want to test with the actual Gitea Actions runner?

### 1. Install Gitea Runner
```bash
# Download from https://dl.gitea.com/act_runner/
# Or use Docker:
docker pull gitea/act_runner:latest
```

### 2. Register Local Runner
```bash
# Create a personal access token in Gitea:
# User Settings → Applications → Generate New Token
# Scope: repo

# Register runner (you'll need your Gitea URL and token)
./act_runner register \
  --instance https://gt.plainskill.net \
  --token <your-token> \
  --name "local-runner-$(hostname)" \
  --labels "local,ubuntu-latest"
```

### 3. Run Locally
```bash
# Start the runner
./act_runner daemon

# In another terminal, push to trigger workflow
# Or manually trigger via Gitea UI
```

### 4. Stop When Done
```bash
# Unregister to clean up
./act_runner unregister
```

## 📊 Speed Comparison

| Method | Approximate Time | Setup Required |
|--------|-----------------|----------------|
| `make test` | 30-60s | Go installed |
| `./scripts/local-ci.sh` | 2-5 min | Go + Node |
| `act` | 5-15 min | Docker + Act |
| Local Gitea Runner | 5-10 min | Docker + Runner |
| Gitea CI (remote) | 10-30 min | None |

## 🎭 Simulating CI Environment

Want to test exactly like CI does?

```bash
# Clean environment (like CI)
make clean
rm -rf node_modules

# Fresh install (like CI)
npm ci  # instead of npm install

# Set CI environment variable
export CI=true

# Run tests
./scripts/local-ci.sh
```

## 🐛 Debugging Failed Tests

### Get More Output
```bash
# Verbose test output
go test -v ./...

# Specific test
go test -v -run TestFunctionName ./package

# With race detector details
go test -race -v ./...
```

### Check What CI Will Run
```bash
# View workflow file
cat .gitea/workflows/ci.yml

# Dry run (see what would execute)
./scripts/local-ci.sh all 2>&1 | less
```

## 💡 Tips

1. **Pre-commit Hook**: Add to `.git/hooks/pre-commit`:
   ```bash
   #!/bin/bash
   cd server/backend || exit 1
   make lint && make test
   ```

2. **VS Code Integration**: Add to `.vscode/settings.json`:
   ```json
   {
     "go.testFlags": ["-race"],
     "go.toolsManagement.autoUpdate": false
   }
   ```

3. **Parallel Testing**: Speed up with:
   ```bash
   go test -p 8 ./...  # Run 8 packages in parallel
   ```

4. **Watch Mode**: Auto-run tests on change:
   ```bash
   # Install reflex
   go install github.com/cespare/reflex@latest
   
   # Watch and test
   reflex -r '\.go$' -- go test ./...
   ```

## 🚨 Common Issues

### "gofmt: command not found"
Make sure Go is installed and in your PATH.

### "npm: command not found"
Install Node.js from https://nodejs.org/

### "permission denied"
Make scripts executable:
```bash
chmod +x scripts/local-ci.sh
```

### Race tests take too long
They're slow by design. Run them only before major releases:
```bash
# Skip race tests for quick iterations
make test  # Fast
make test-race  # Slow but thorough
```

## 📚 Additional Resources

- [Go Testing Documentation](https://golang.org/pkg/testing/)
- [Act Documentation](https://github.com/nektos/act)
- [Gitea Actions Documentation](https://docs.gitea.com/usage/actions/overview)
- [Go Race Detector](https://go.dev/doc/articles/race_detector)

---

**Happy Testing!** 🧪✨

Remember: Running tests locally is ~10x faster than waiting for CI runners!

package tests

import (
	"fmt"
	"time"
)

var DefaultRegistry = &Registry{
	tests: make(map[string]*Test),
}

type Registry struct {
	tests map[string]*Test
	order []string
}

func (r *Registry) Add(t *Test) {
	r.tests[t.ID] = t
	r.order = append(r.order, t.ID)
}

func (r *Registry) Get(id string) (*Test, bool) {
	t, ok := r.tests[id]
	return t, ok
}

func (r *Registry) List() []*Test {
	result := make([]*Test, 0, len(r.tests))
	for _, id := range r.order {
		result = append(result, r.tests[id])
	}
	return result
}

func (r *Registry) GetByIDs(ids []string) []*Test {
	result := make([]*Test, 0, len(ids))
	for _, id := range ids {
		if t, ok := r.tests[id]; ok {
			result = append(result, t)
		}
	}
	return result
}

func init() {
	addGoTests()
	addFrontendTests()
	addFuzzTests()
	addE2ETests()
	addSecurityTests()
	addIntegrationTests()
	addSupportTests()
}

func addGoTests() {
	DefaultRegistry.Add(&Test{
		ID:          "go-fmt",
		Name:        "Go Format Check",
		Description: "Check that all Go files are properly formatted with gofmt",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "find . -name '*.go' -not -path './.cache/*' -not -path './vendor/*' -not -path './bin/*' -not -path '*/.git/*' | xargs gofmt -l | grep -q . && echo 'Files need formatting:' && find . -name '*.go' -not -path './.cache/*' -not -path './vendor/*' -not -path './bin/*' -not -path '*/.git/*' | xargs gofmt -l && exit 1 || echo 'All files formatted'",
		WorkDir:     "/repo/server/backend",
		Timeout:     5 * time.Minute,
	})

	DefaultRegistry.Add(&Test{
		ID:          "go-vet",
		Name:        "Go Vet",
		Description: "Run go vet to detect suspicious constructs",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "go vet ./...",
		WorkDir:     "/repo/server/backend",
		Timeout:     3 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "go-test",
		Name:        "Go Unit Tests",
		Description: "Run all Go unit tests",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "apk add --no-cache gcc musl-dev && CGO_ENABLED=1 go test -v ./...",
		WorkDir:     "/repo/server/backend",
		Timeout:     10 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "go-race",
		Name:        "Race Detection",
		Description: "Run tests with race detector enabled",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "apk add --no-cache gcc musl-dev && CGO_ENABLED=1 go test -race -v ./internal/api/middleware/... ./internal/auth/... ./internal/jobqueue/...",
		WorkDir:     "/repo/server/backend",
		Timeout:     20 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache", "GORACE=halt_on_error=1"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "go-build",
		Name:        "Go Build",
		Description: "Verify that the Go code compiles successfully",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "apk add --no-cache make && make build",
		WorkDir:     "/repo/server/backend",
		Timeout:     5 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})
}

func addFrontendTests() {
	DefaultRegistry.Add(&Test{
		ID:          "frontend-lint",
		Name:        "ESLint",
		Description: "Run ESLint on frontend code",
		Type:        TestTypeUnit,
		Container:   "node:20-alpine",
		Command:     "npm install --no-fund && npm run lint",
		WorkDir:     "/repo/server/frontend",
		Timeout:     10 * time.Minute,
	})

	DefaultRegistry.Add(&Test{
		ID:          "frontend-build",
		Name:        "Frontend Build",
		Description: "Build the frontend application",
		Type:        TestTypeUnit,
		Container:   "node:20-alpine",
		Command:     "npm install --no-fund && npm run build",
		WorkDir:     "/repo/server/frontend",
		Timeout:     15 * time.Minute,
	})

	DefaultRegistry.Add(&Test{
		ID:          "frontend-colors",
		Name:        "Color Scan",
		Description: "Scan for hardcoded colors that should use CSS variables",
		Type:        TestTypeUnit,
		Container:   "node:20-alpine",
		Command:     "npm install --no-fund && npm run scan:colors",
		WorkDir:     "/repo/server/frontend",
		Timeout:     10 * time.Minute,
	})
}

func addFuzzTests() {
	fuzzTests := []struct {
		id     string
		name   string
		pkg    string
		fuzzFn string
	}{
		{"fuzz-docker-unmarshal", "Fuzz: Docker Compose Unmarshal", "internal/docker", "FuzzComposeUnmarshal"},
		{"fuzz-docker-marshal", "Fuzz: Docker Compose Marshal", "internal/docker", "FuzzComposeMarshal"},
		{"fuzz-apps-definition", "Fuzz: App Definition Parsing", "internal/apps", "FuzzAppDefinitionUnmarshal"},
		{"fuzz-apps-script", "Fuzz: Script Action Parsing", "internal/apps", "FuzzScriptActionUnmarshal"},
		{"fuzz-network-caddyfile", "Fuzz: Caddyfile Template", "internal/network", "FuzzCaddyfileTemplate"},
		{"fuzz-network-route", "Fuzz: Route Domain Parsing", "internal/network", "FuzzRouteViewDomain"},
		{"fuzz-network-backend", "Fuzz: Backend URL Parsing", "internal/network", "FuzzBackendURL"},
		{"fuzz-config-main", "Fuzz: Config Unmarshal", "internal/config", "FuzzConfigUnmarshal"},
		{"fuzz-config-smtp", "Fuzz: SMTP Config Parsing", "internal/config", "FuzzSMTPConfigUnmarshal"},
		{"fuzz-config-docker", "Fuzz: Docker Config Parsing", "internal/config", "FuzzDockerConfigUnmarshal"},
		{"fuzz-config-caddy", "Fuzz: Caddy Config Parsing", "internal/config", "FuzzCaddyConfigUnmarshal"},
		{"fuzz-config-acme", "Fuzz: ACME Config Parsing", "internal/config", "FuzzExternalACMEConfigUnmarshal"},
	}

	for _, ft := range fuzzTests {
		DefaultRegistry.Add(&Test{
			ID:          ft.id,
			Name:        ft.name,
			Description: fmt.Sprintf("Fuzz %s for edge cases and panics", ft.fuzzFn),
			Type:        TestTypeFuzz,
			Container:   "golang:1.25-alpine",
			Command:     fmt.Sprintf(`go test -fuzz=%s -fuzztime=5m -run=^$ ./%s`, ft.fuzzFn, ft.pkg),
			WorkDir:     "/repo/server/backend",
			Timeout:     10 * time.Minute,
			Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
			FuzzPackage: ft.pkg,
		})
	}
}

func addE2ETests() {
	DefaultRegistry.Add(&Test{
		ID:          "e2e",
		Name:        "E2E Tests",
		Description: "Run Playwright end-to-end tests (with server)",
		Type:        TestTypeE2E,
		Container:   "mcr.microsoft.com/playwright:v1.58.2-jammy",
		Command: `
			set -e
			
			# Install docker CLI and buildx
			if ! command -v docker &> /dev/null; then
				echo "Installing docker..."
				apt-get update -qq && apt-get install -y -qq docker.io docker-buildx
			fi
			
			# Wait for host docker to be available
			echo "Waiting for docker daemon..."
			for i in $(seq 1 60); do
				if docker info >/dev/null 2>&1; then
					echo "Docker is ready!"
					break
				fi
				if [ $i -eq 60 ]; then
					echo "ERROR: Docker daemon not accessible after 60s"
					exit 1
				fi
				sleep 1
			done
			
			# Build the server image (disable BuildKit to avoid buildx issues)
			echo "Building server image..."
			cd /repo
			DOCKER_BUILDKIT=0 docker build -t libreserv:e2e-test . || {
				echo "ERROR: Failed to build server image"
				exit 1
			}
			echo "Server image built successfully"
			
			# Setup data directories
			mkdir -p /tmp/libreserv-e2e-data /tmp/libreserv-e2e-configs
			
			# Cleanup any existing container from previous runs
			echo "Cleaning up old container..."
			docker rm -f libreserv-e2e 2>/dev/null || true
			
			# Try ports in sequence until one works
			E2E_PORT=""
			for port in 8080 8081 8082 8083 8084; do
				echo "Trying port $port..."
				if docker run -d --name libreserv-e2e-test -p ${port}:8080 --rm alpine:latest sleep 5 2>/dev/null; then
					docker stop libreserv-e2e-test 2>/dev/null || true
					E2E_PORT=$port
					break
				fi
			done
			
			if [ -z "$E2E_PORT" ]; then
				echo "ERROR: No available port found (tried 8080-8084)"
				exit 1
			fi
			
			echo "Using port $E2E_PORT"
			
			# Run server directly with docker run
			echo "Starting server on port $E2E_PORT..."
			docker run -d \
				--name libreserv-e2e \
				-p ${E2E_PORT}:8080 \
				-v /var/run/docker.sock:/var/run/docker.sock:ro \
				-v /tmp/libreserv-e2e-data:/app/data \
				-v /tmp/libreserv-e2e-configs:/app/configs \
				-e LIBRESERV_DOCKER_METHOD=socket \
				-e LIBRESERV_DOCKER_SOCKET_PATH=/var/run/docker.sock \
				-e LIBRESERV_NETWORK_CADDY_MODE=disabled \
				libreserv:e2e-test
			
			# Wait for server to be ready
			echo "Waiting for server to be ready..."
			for i in $(seq 1 60); do
				if curl -s http://localhost:${E2E_PORT}/api/v1/health >/dev/null 2>&1; then
					echo "Server is ready!"
					break
				fi
				if [ $i -eq 60 ]; then
					echo "ERROR: Server failed to start"
					docker logs libreserv-e2e || true
					docker stop libreserv-e2e || true
					docker rm libreserv-e2e || true
					exit 1
				fi
				sleep 1
			done
			
			# Run playwright tests
			echo "Running Playwright tests..."
			cd /repo/e2e-tests
			npm ci 2>/dev/null || npm install
			npx playwright test --reporter=list --max-failures=5 || TEST_FAILED=1
			
			# Cleanup
			docker stop libreserv-e2e || true
			docker rm libreserv-e2e || true
			
			exit ${TEST_FAILED:-0}
		`,
		WorkDir: "/repo",
		Timeout: 30 * time.Minute,
		Env:     []string{},
	})
}

func addSecurityTests() {
	DefaultRegistry.Add(&Test{
		ID:          "govulncheck",
		Name:        "Vulnerability Check",
		Description: "Check for known vulnerabilities in dependencies",
		Type:        TestTypeSecurity,
		Container:   "golang:1.25-alpine",
		Command:     "go install golang.org/x/vuln/cmd/govulncheck@latest && $(go env GOPATH)/bin/govulncheck ./...",
		WorkDir:     "/repo/server/backend",
		Timeout:     5 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "gosec",
		Name:        "Security Scanner (gosec)",
		Description: "Scan code for security problems",
		Type:        TestTypeSecurity,
		Container:   "golang:1.25-alpine",
		Command:     "CGO_ENABLED=0 go install github.com/securego/gosec/v2/cmd/gosec@latest && $(go env GOPATH)/bin/gosec -severity high -confidence high -exclude G104,G101,G702,G703,G704 ./internal/... ./cmd/... 2>&1",
		WorkDir:     "/repo/server/backend",
		Timeout:     2 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "staticcheck",
		Name:        "Static Analysis",
		Description: "Run staticcheck for code quality issues",
		Type:        TestTypeSecurity,
		Container:   "golang:1.25-alpine",
		Command:     "CGO_ENABLED=0 go install honnef.co/go/tools/cmd/staticcheck@latest && $(go env GOPATH)/bin/staticcheck -checks all,-ST1,-ST1000 ./internal/... ./cmd/...",
		WorkDir:     "/repo/server/backend",
		Timeout:     2 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})
}

func addIntegrationTests() {
	DefaultRegistry.Add(&Test{
		ID:          "coverage",
		Name:        "Coverage Report",
		Description: "Generate test coverage report",
		Type:        TestTypeIntegration,
		Container:   "golang:1.25-alpine",
		Command:     "apk add --no-cache gcc musl-dev && CGO_ENABLED=1 go test -coverprofile=coverage.out -covermode=atomic ./... && go tool cover -func=coverage.out && go tool cover -html=coverage.out -o coverage.html",
		WorkDir:     "/repo/server/backend",
		Timeout:     10 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "docker-build",
		Name:        "Docker Build",
		Description: "Build the Docker image",
		Type:        TestTypeIntegration,
		Container:   "docker:cli",
		Command:     "docker build -t libreserv:test .",
		WorkDir:     "/repo",
		Timeout:     20 * time.Minute,
		SkipIf:      "no-docker",
	})
}

func addSupportTests() {
	DefaultRegistry.Add(&Test{
		ID:          "support-relay",
		Name:        "Support Relay Tests",
		Description: "Run tests for support-relay module",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "go test -v ./...",
		WorkDir:     "/repo/support/support-relay",
		Timeout:     5 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})

	DefaultRegistry.Add(&Test{
		ID:          "support-server",
		Name:        "Support Server Tests",
		Description: "Run tests for support-server module",
		Type:        TestTypeUnit,
		Container:   "golang:1.25-alpine",
		Command:     "go test -v ./...",
		WorkDir:     "/repo/support/support-server",
		Timeout:     5 * time.Minute,
		Env:         []string{"GOCACHE=/cache/gocache", "GOMODCACHE=/cache/gomodcache"},
	})
}

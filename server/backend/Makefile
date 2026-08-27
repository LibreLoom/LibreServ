APP_NAME := libreserv
BIN_DIR := bin
RESTIC_VERSION ?= 0.19.1
RESTIC_DIR := OS/bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME ?=
GIT_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_TAGS ?=
GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)

LDVARS := -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$(VERSION) \
          -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$(GIT_COMMIT)
ifneq ($(strip $(BUILD_TIME)),)
LDVARS += -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$(BUILD_TIME)
endif
LDFLAGS := -ldflags "$(LDVARS)"
# CODE QUALITY FIX: correctly handle empty BUILD_TAGS (was -tags "" causing vet to see empty tag)
TAGS_FLAG := $(if $(strip $(BUILD_TAGS)),-tags "$(BUILD_TAGS)",)

default: build

build:
	@echo ">> Building backend $(VERSION)"
	@mkdir -p $(BIN_DIR)
	@GOOS=$(GOOS) GOARCH=$(GOARCH) go build $(TAGS_FLAG) $(LDFLAGS) -o $(BIN_DIR)/$(APP_NAME) ./cmd/libreserv

run: build
	@if [ ! -f ./configs/libreserv.yaml ]; then \
		echo "Error: ./configs/libreserv.yaml not found. Copy it from the example:"; \
		echo "  cp configs/libreserv.yaml.example configs/libreserv.yaml"; \
		exit 1; \
	fi
	@echo ">> Running $(APP_NAME)"
	@LIBRESERV_INSECURE_DEV=true ./$(BIN_DIR)/$(APP_NAME) serve --config ./configs/libreserv.yaml

frontend:
	@echo ">> Installing frontend deps"
	@cd ../frontend && npm ci

frontend-build: frontend
	@echo ">> Building frontend"
	@cd ../frontend && npm run build
	@echo ">> Frontend built to OS/dist/"

restic-fetch:
	@echo ">> Downloading restic $(RESTIC_VERSION) for $(GOOS)/$(GOARCH)"
	@mkdir -p $(RESTIC_DIR)
	@curl -fSL "https://github.com/restic/restic/releases/download/v$(RESTIC_VERSION)/restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2" \
		| bzip2 -d > $(RESTIC_DIR)/restic
	@chmod +x $(RESTIC_DIR)/restic
	@echo ">> restic placed in $(RESTIC_DIR)/restic"
# restic-fetch with checksum verification (use restic-fetch-verified for supply-chain safety).
# The checksum MUST be verified against the downloaded .bz2 archive BEFORE
# decompressing — verifying after would either checksum a file that no longer
# exists or checksum the wrong bytes entirely.
restic-fetch-verified:
	@echo ">> Downloading restic $(RESTIC_VERSION) for $(GOOS)/$(GOARCH) with checksum verification"
	@mkdir -p $(RESTIC_DIR)
	@cd $(RESTIC_DIR) && \
	curl -fSL -o restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2 \
		"https://github.com/restic/restic/releases/download/v$(RESTIC_VERSION)/restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2" && \
	curl -fSL "https://github.com/restic/restic/releases/download/v$(RESTIC_VERSION)/SHA256SUMS" \
		| grep "restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2" > SHA256SUMS.tmp && \
	sha256sum -c SHA256SUMS.tmp || \
		{ echo "checksum mismatch!"; rm -f restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2 SHA256SUMS.tmp; exit 1; }
	@bzip2 -dc $(RESTIC_DIR)/restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2 > $(RESTIC_DIR)/restic
	@rm -f $(RESTIC_DIR)/restic_$(RESTIC_VERSION)_$(GOOS)_$(GOARCH).bz2 $(RESTIC_DIR)/SHA256SUMS.tmp
	@chmod +x $(RESTIC_DIR)/restic
	@echo ">> verified restic placed in $(RESTIC_DIR)/restic"

restic-clean:
	@echo ">> Removing downloaded restic binary"
	@rm -f $(RESTIC_DIR)/restic

# Testing targets
test:
	@echo ">> Running tests"
	@go test $(GO_PKGS)

test-race:
	@echo ">> Running tests with race detector"
	@go test -race -count=3 ./internal/api/middleware/... ./internal/auth/... ./internal/jobqueue/...

test-coverage:
	@echo ">> Running tests with coverage"
	@go test -coverprofile=coverage.out -covermode=atomic $(GO_PKGS)
	@go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

FMT_SOURCES := $(shell find . -name '*.go' -not -path './.cache/*' -not -path './vendor/*' -not -path './dev/*' 2>/dev/null)
GO_PKGS := ./cmd/... ./internal/...
GO_ALL_PKGS := ./cmd/... ./internal/... ../../ci-source/... ../../connect/...

fmt-check:
	@echo ">> Checking format"
	@test -z "$(shell echo '$(FMT_SOURCES)' | xargs gofmt -l 2>/dev/null)" || \
		(echo "Files need formatting:" && echo '$(FMT_SOURCES)' | xargs gofmt -l && exit 1)

vet:
	@echo ">> Running go vet"
	@go vet $(GO_PKGS)

lint: fmt-check vet

# Security scanning
govulncheck:
	@echo ">> Running govulncheck"
	@./govulncheck-with-exemptions.sh $(GO_PKGS)

gosec:
	@echo ">> Running gosec (backend)"
	@gosec -severity high $(GO_PKGS)
	@echo ">> Running gosec (ci-source)"
	@cd ../../ci-source && gosec -severity high ./...
	@echo ">> Running gosec (connect)"
	@cd ../../connect && gosec -severity high ./...

staticcheck:
	@echo ">> Running staticcheck"
	@staticcheck -checks all,-ST1*,-ST1000 $(GO_PKGS)
	@echo ">> Running staticcheck (connect)"
	@cd ../../connect && staticcheck -checks all,-ST1*,-ST1000 ./internal/... ./cmd/...

security: govulncheck gosec staticcheck

# CI shortcuts
ci-local:
	@echo ">> Running local CI tests"
	@../../scripts/local-ci.sh go

ci-all:
	@echo ">> Running all CI tests"
	@../../scripts/local-ci.sh all

ci-docker:
	@echo ">> Testing Docker build"
	@docker build -t libreserv:local-test ../..

# Clean
clean:
	@echo ">> Cleaning build artifacts"
	@rm -rf $(BIN_DIR) coverage.out coverage.html

.PHONY: default build run frontend frontend-build restic-fetch restic-clean test test-race test-coverage fmt-check vet lint govulncheck gosec staticcheck security ci-local ci-all ci-docker clean

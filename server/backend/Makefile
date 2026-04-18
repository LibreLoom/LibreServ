APP_NAME := libreserv
BIN_DIR := bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME ?=
GIT_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")
BUILD_TAGS ?=

LDVARS := -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$(VERSION) \
          -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$(GIT_COMMIT)
ifneq ($(strip $(BUILD_TIME)),)
LDVARS += -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$(BUILD_TIME)
endif
LDFLAGS := -ldflags "$(LDVARS)"

default: build

build:
	@echo ">> Building backend $(VERSION)"
	@mkdir -p $(BIN_DIR)
	@GOOS=$(GOOS) GOARCH=$(GOARCH) go build -tags "$(BUILD_TAGS)" $(LDFLAGS) -o $(BIN_DIR)/$(APP_NAME) ./cmd/libreserv

run: build
	@echo ">> Running $(APP_NAME)"
	@LIBRESERV_INSECURE_DEV=true ./$(BIN_DIR)/$(APP_NAME) serve --config ./configs/libreserv.yaml

frontend:
	@echo ">> Installing frontend deps"
	@cd ../frontend && npm ci

frontend-build: frontend
	@echo ">> Building frontend"
	@cd ../frontend && npm run build
	@echo ">> Frontend built to OS/dist/"

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
	@govulncheck $(GO_PKGS)

gosec:
	@echo ">> Running gosec"
	@gosec -severity high $(GO_PKGS)

staticcheck:
	@echo ">> Running staticcheck"
	@staticcheck $(GO_PKGS)

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

.PHONY: default build run frontend frontend-build test test-race test-coverage fmt-check vet lint govulncheck gosec staticcheck security ci-local ci-all ci-docker clean

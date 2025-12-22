APP_NAME := libreserv
BIN_DIR := bin

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
BUILD_TIME := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
GIT_COMMIT := $(shell git rev-parse HEAD 2>/dev/null || echo "unknown")

LDFLAGS := -ldflags "-X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.Version=$(VERSION) \
                     -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.BuildTime=$(BUILD_TIME) \
                     -X gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers.GitCommit=$(GIT_COMMIT)"

default: build

build:
	@echo ">> Building backend $(VERSION)"
	@mkdir -p $(BIN_DIR)
	@GOOS=$(GOOS) GOARCH=$(GOARCH) go build $(LDFLAGS) -o $(BIN_DIR)/$(APP_NAME) ./cmd/libreserv

run: build
	@echo ">> Running $(APP_NAME)"
	@./$(BIN_DIR)/$(APP_NAME) serve --config ./configs/libreserv.yaml

frontend:
	@echo ">> Installing frontend deps"
	@cd web && npm install

frontend-build: frontend
	@echo ">> Building frontend"
	@cd web && npm run build

.PHONY: default build run frontend frontend-build

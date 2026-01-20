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
	@rm -rf OS/dist
	@mkdir -p OS/dist
	@cp -R ../frontend/dist/. OS/dist/

.PHONY: default build run frontend frontend-build

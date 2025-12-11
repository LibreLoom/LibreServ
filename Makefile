APP_NAME := libreserv
BIN_DIR := bin

default: build

build:
	@echo ">> Building backend"
	@mkdir -p $(BIN_DIR)
	@GOOS=$(GOOS) GOARCH=$(GOARCH) go build -o $(BIN_DIR)/$(APP_NAME) ./cmd/libreserv

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

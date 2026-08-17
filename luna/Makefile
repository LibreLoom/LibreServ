SHELL := /bin/bash
PORT ?= 8090
DATA_DIR ?= $(shell if [ "$$(id -u)" = 0 ]; then echo /var/lib/luna; else echo $$HOME/.local/share/luna; fi)
MAKEFLAGS += --no-print-directory

.PHONY: web build test run dev dev-daemon dev-web lint clean

web:
	cd web && npm install --no-audit --no-fund
	cd web && npm run build

build: web
	cargo build -p lunad

test:
	cargo test --workspace
	cd web && npm test -- --run

run: build
	./target/debug/lunad --port $(PORT)

# DEV MODE: one command. daemon :PORT + Vite HMR :3000; Ctrl-C kills both.
dev: build-daemon
	@echo "==> luna dev — daemon http://localhost:$(PORT) + UI http://localhost:3000"
	@trap 'kill 0' EXIT; \
	  LUNA_DATA_DIR="$(DATA_DIR)" ./target/debug/lunad --port $(PORT) & \
	  (cd web && npm install --no-audit --no-fund >/dev/null && npm run dev) & \
	  wait

build-daemon:
	cargo build -p lunad

dev-daemon: build-daemon
	LUNA_DATA_DIR="$(DATA_DIR)" ./target/debug/lunad --port $(PORT)

dev-web:
	cd web && npm install --no-audit --no-fund
	cd web && npm run dev

lint:
	cargo fmt --check
	cargo clippy --workspace -- -D warnings
	cd web && npm run lint

clean:
	cargo clean
	rm -rf web/node_modules web/dist crates/lunad/web/dist

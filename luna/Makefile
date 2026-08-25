SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PORT ?= 8090
DATA_DIR ?= $(ROOT)/dev
MAKEFLAGS += --no-print-directory

.PHONY: web build test run dev dev-daemon dev-web lint clean iso desktop desktop-bundle desktop-dev ensure-web-dist

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

# Embed needs crates/lunad/web/dist. Cargo build.rs writes a stub HTML page when
# dist is missing; refuse to leave that stub in place for run/dev builds.
ensure-web-dist:
	@idx="$(ROOT)/crates/lunad/web/dist/index.html"; \
	if [ ! -f "$$idx" ] || grep -Fq 'build the web app first' "$$idx"; then \
	  echo "==> Luna web dist missing or stub — building web UI"; \
	  $(MAKE) web; \
	fi

build-daemon: ensure-web-dist
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

iso:
	./os/build-iso.sh

clean:
	cargo clean
	rm -rf web/node_modules web/dist crates/lunad/web/dist

# Linux desktop: one command for a bundled .deb + AppImage. No Apple/Windows
# signing. Needs webkitgtk and the Tauri Linux deps (see desktop/README.md).
desktop-dev:
	cd desktop && npm install --no-audit --no-fund && npm run tauri -- dev

desktop:
	cd desktop && npm install --no-audit --no-fund
	cd desktop/src-tauri && cargo test
	cd desktop && npm run tauri -- build --no-bundle

desktop-bundle: desktop
	cd desktop && npm run tauri -- build --bundles deb,appimage

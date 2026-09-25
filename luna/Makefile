SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PORT ?= 8090
DATA_DIR ?= $(ROOT)/dev
DS_IMAGE ?= ghcr.io/euro-office/documentserver:latest
DRAWIO_VERSION ?= v31.5.2
MAKEFLAGS += --no-print-directory

.PHONY: web build test run dev dev-daemon daemon-dev dev-web lint clean iso desktop desktop-bundle desktop-dev desktop-dev-login desktop-appimage desktop-flatpak ensure-web-dist mock-drive mock-connect mobile-dev mobile-dev-repair companion-dev eurooffice eurooffice-assets eurooffice-pack drawio drawio-pack

web:
	cd ../shared/ui && npm install --no-audit --no-fund
	cd web && npm install --no-audit --no-fund
	cd web && npm run build

build: web
	cargo build -p lunad

test:
	cargo test --workspace
	cd web && npm test -- --run

run: build
	./target/debug/lunad --port $(PORT)

# DEV MODE: one command. daemon :PORT + Vite HMR :3001; Ctrl-C kills both.
# Two teardown paths because `make` here is a distrobox wrapper: podman exec
# forwards Ctrl-C only to make itself, so the recipe never sees a signal. The
# stdin watchdog below catches that — when the host client dies the exec
# session's stdin pipe closes, read gets EOF, and the group is killed.
# (Backgrounded jobs get stdin=/dev/null, hence the explicit <&0 and the -p
# guard so a headless `make dev </dev/null` doesn't self-kill instantly.)
dev: build-daemon
	@echo "==> luna dev — daemon http://localhost:$(PORT) + UI http://localhost:3001"
	@echo "    Tip: spawn test drives with: make mock-drive ARGS=\"spawn <name> <preset>\""
	@[ -d "$(DATA_DIR)/eurooffice" ] || \
	  echo "    Tip: office editing needs the EuroOffice pack: make eurooffice"
	@[ -d "$(DATA_DIR)/drawio" ] || \
	  echo "    Tip: diagram editing needs the draw.io pack: make drawio"
	@trap 'kill 0' INT TERM EXIT; \
	  if [ -p /dev/stdin ]; then \
	    ( while read -r _; do :; done; kill 0 2>/dev/null ) <&0 & \
	  fi; \
	  LUNA_DATA_DIR="$(DATA_DIR)" ./target/debug/lunad --port $(PORT) & \
	  (cd web && npm install --no-audit --no-fund >/dev/null && npm run dev) & \
	  wait -n

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

mock-drive:
	bash scripts/mocks/mock-drive.sh $(ARGS)

mock-connect:
	bash scripts/mocks/mock-connect.sh $(ARGS)

# EuroOffice dev pack (AGPL, never committed): extracts web-apps/sdkjs +
# core-fonts into $(DATA_DIR)/eurooffice, generates the font metrics sdkjs
# needs, and fetches the x2t.wasm converter. Editing runs entirely in the
# browser — no Document Server. See docs/eurooffice.md.
eurooffice: eurooffice-assets

eurooffice-assets:
	LUNA_DATA_DIR="$(DATA_DIR)" EUROOFFICE_IMAGE="$(DS_IMAGE)" \
		bash scripts/install-eurooffice-assets.sh

# Release pack: os/dist/eurooffice-pack.tar.zst, baked into the install ISO
# and extracted onto LUNA_DATA by rapidinstall. Reuses the dev pack when
# present (EUROOFFICE_DIR to point elsewhere); fetches it otherwise.
eurooffice-pack:
	LUNA_DATA_DIR="$(DATA_DIR)" sh scripts/build-eurooffice-pack.sh

# draw.io dev pack (Apache-2.0, never committed): downloads draw.war from a
# pinned jgraph/drawio GitHub release and unpacks the static webapp into
# $(DATA_DIR)/drawio — lunad serves it at /drawio for the embedded editor.
# See docs/drawio.md.
drawio:
	LUNA_DATA_DIR="$(DATA_DIR)" DRAWIO_VERSION="$(DRAWIO_VERSION)" \
		bash scripts/install-drawio-assets.sh

# Release pack: os/dist/drawio-pack.tar.zst, baked into the install ISO and
# extracted onto LUNA_DATA by rapidinstall. Reuses the dev pack when present
# (DRAWIO_DIR to point elsewhere); fetches it otherwise.
drawio-pack:
	LUNA_DATA_DIR="$(DATA_DIR)" sh scripts/build-drawio-pack.sh

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


# Watch lunad: cargo-watch rebuild+restart on Rust save. Needs a one-time web dist.
daemon-dev:
	chmod +x scripts/dev-daemon.sh scripts/ensure-dev-token.sh
	bash scripts/dev-daemon.sh

# Android rapid-dev: installDebug + relaunch on save. Needs adb device/emulator + lunad.
# First launch opens luna://pair; DEBUG builds auto-sign in. Token cache: mobile/.dev/
mobile-dev:
	chmod +x mobile/scripts/dev.sh mobile/scripts/ensure-dev-token.sh
	cd mobile && bash scripts/dev.sh

mobile-dev-repair:
	LUNA_MOBILE_REPAIR=1 $(MAKE) mobile-dev

# Print the three-terminal companion rapid-dev recipe.
companion-dev:
	@echo "Luna companion rapid-dev (three terminals):"
	@echo "  1) cd luna && make daemon-dev          # lunad :8090, restarts on Rust save"
	@echo "  2) cd luna && make desktop-dev         # GTK app, cargo-watch + auto sign-in"
	@echo "  3) cd luna && make mobile-dev          # Android installDebug on save (adb)"
	@echo "Optional: make dev-web                   # Vite HMR for the Luna web UI"
	@echo "Emulator uses http://10.0.2.2:8090; phone needs LUNA_MOBILE_URL=http://<lan-ip>:8090"

# Linux desktop (GTK 4 + libadwaita). See desktop/README.md for packages.
# Ship: Flatpak on Linux, .exe installer on Windows. AppImage is demo/CI only.
# Rapid GTK loop: cargo-watch + GTK Inspector + auto sign-in to local Luna.
# Needs lunad on :8090 (make dev-daemon). Default user: desktop / hunter22hunter1.
desktop-dev:
	chmod +x desktop/scripts/dev.sh desktop/scripts/ensure-dev-token.sh
	cd desktop && bash scripts/dev.sh

desktop-dev-login:
	LUNA_DESKTOP_AUTO_LOGIN=0 $(MAKE) desktop-dev

desktop:
	cd desktop && cargo test && cargo build --release

desktop-appimage: desktop
	cd desktop && bash packaging/appimage/build.sh

# Build + export a single-file Flatpak bundle for Forgejo releases.
ARCH ?= $(shell uname -m)
FLATPAK_BUNDLE ?= $(CURDIR)/desktop/release/luna-desktop-$(ARCH).flatpak
desktop-flatpak:
	mkdir -p desktop/release desktop/packaging/flatpak/repo
	cd desktop/packaging/flatpak && flatpak-builder \
		--user --force-clean --install-deps-from=flathub \
		--repo=repo build-dir org.libreloom.LunaDesktop.yml
	flatpak build-bundle desktop/packaging/flatpak/repo "$(FLATPAK_BUNDLE)" \
		org.libreloom.LunaDesktop \
		--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
	@echo "Flatpak bundle: $(FLATPAK_BUNDLE) ($(ARCH))"

desktop-bundle: desktop-flatpak
	@echo "Preferred Linux ship: $(FLATPAK_BUNDLE)"
	@echo "Demo AppImage (optional): make desktop-appimage"
	@echo "Windows: see desktop/packaging/windows/README.md"
	@echo "macOS: run on a Mac — cd luna/desktop && bash packaging/macos/build.sh"

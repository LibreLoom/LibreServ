SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PORT ?= 8090
DATA_DIR ?= $(ROOT)/dev
DS_PORT ?= 8088
DS_IMAGE ?= ghcr.io/euro-office/documentserver:latest
MAKEFLAGS += --no-print-directory

.PHONY: web build test run dev dev-daemon daemon-dev dev-web lint clean iso desktop desktop-bundle desktop-dev desktop-dev-login desktop-appimage desktop-flatpak ensure-web-dist mock-pssd mock-pssd-photos mock-drive mock-connect mobile-dev mobile-dev-repair companion-dev eurooffice eurooffice-assets eurooffice-ds eurooffice-ds-stop

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
	@echo "    Tip: spawn test drives with: make mock-drive ARGS=\"spawn <name> <preset>\""
	@[ -d "$(DATA_DIR)/eurooffice" ] || \
	  echo "    Tip: office editing needs EuroOffice assets + DS sidecar: make eurooffice"
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

mock-pssd:
	bash scripts/setup-mock-pssd.sh

mock-pssd-photos:
	python3 scripts/generate-mock-pssd-photos.py

mock-drive:
	bash scripts/mock-drive.sh $(ARGS)

mock-connect:
	bash scripts/mock-connect.sh $(ARGS)

# EuroOffice dev pack (AGPL, never committed): extract web-apps/sdkjs/fonts into
# $(DATA_DIR)/eurooffice, then run a Document Server sidecar on :$(DS_PORT) for
# DocsAPI/co-authoring. See docs/eurooffice.md.
eurooffice: eurooffice-assets eurooffice-ds

eurooffice-assets:
	LUNA_DATA_DIR="$(DATA_DIR)" EUROOFFICE_IMAGE="$(DS_IMAGE)" \
		bash scripts/install-eurooffice-assets.sh

# JWT_ENABLED=false: this is a local dev helper only — production never runs
# it, so request signing between lunad and the DS is unnecessary here.
# ALLOW_PRIVATE_IP_ADDRESS=true: the DS fetches documents from lunad over
# host.containers.internal, which resolves to a private/link-local address.
eurooffice-ds:
	podman image exists "$(DS_IMAGE)" || podman pull "$(DS_IMAGE)"
	podman rm -f eurooffice-ds 2>/dev/null || true
	podman run -d --name eurooffice-ds \
		--add-host=host.containers.internal:host-gateway \
		-p $(DS_PORT):80 -e JWT_ENABLED=false \
		-e ALLOW_PRIVATE_IP_ADDRESS=true "$(DS_IMAGE)"
	@echo "==> EuroOffice DS on http://127.0.0.1:$(DS_PORT) (boots in ~30-60s)"

eurooffice-ds-stop:
	podman rm -f eurooffice-ds

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

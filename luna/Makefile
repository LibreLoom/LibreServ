SHELL := /bin/bash
ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PORT ?= 8090
DATA_DIR ?= $(ROOT)/dev
MAKEFLAGS += --no-print-directory

.PHONY: web build test run dev dev-daemon daemon-dev dev-web lint clean iso desktop desktop-bundle desktop-dev desktop-dev-login desktop-appimage desktop-flatpak ensure-web-dist mock-pssd mock-pssd-photos mobile-dev mobile-dev-repair companion-dev

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
dev: build-daemon mock-pssd
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

mock-pssd:
	bash scripts/setup-mock-pssd.sh

mock-pssd-photos:
	python3 scripts/generate-mock-pssd-photos.py

dev-daemon: build-daemon mock-pssd
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

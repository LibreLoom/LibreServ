SHELL := /bin/bash
PORT ?= 8090

.PHONY: web build test run lint clean

web:
cd web && npm install --no-audit --no-fund
cd web && npm run build

build: web
cargo build -p lunad

test: web
cargo test --workspace
cd web && npm test -- --run

run: build
./target/debug/lunad --port $(PORT)

lint:
cargo fmt --check
cargo clippy --workspace -- -D warnings
cd web && npm run lint

clean:
cargo clean
rm -rf web/node_modules web/dist crates/lunad/web/dist

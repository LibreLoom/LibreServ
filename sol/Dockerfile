# Stage 1: Build Frontend
# Mirror the repo layout: @libreloom/ui is a file: dep at ../../../shared/ui,
# and npm validates the lockfile's relative path — so the container must have
# the same directory depth as the real repo.
FROM node:22-alpine AS frontend-builder
WORKDIR /repo/sol/server/frontend
COPY shared/ui /repo/shared/ui
COPY sol/server/frontend/package*.json ./
RUN npm ci
# Point the linked package's dependency resolution at the app's own
# node_modules — peers resolve to the app's exact versions, no second install
RUN ln -s /repo/sol/server/frontend/node_modules /repo/shared/ui/node_modules
COPY sol/server/frontend/ ./
# Copy .lore to repo root where frontend expects it
COPY .lore /repo/.lore
# Vite's outDir is ../backend/OS/dist — the backend tree isn't in this stage,
# so pre-create it for the gzip plugin's closeBundle scandir
RUN mkdir -p /repo/sol/server/backend/OS/dist && npm run build

# Stage 2: Build Backend
FROM golang:1.26-alpine AS backend-builder
RUN apk add --no-cache git make
WORKDIR /app/backend
COPY sol/server/backend/go.mod sol/server/backend/go.sum ./
RUN go mod download
COPY sol/server/backend/ ./
# Inject version info during build
ARG VERSION=dev
RUN VERSION=${VERSION} make build

# Stage 3: Final Image
FROM alpine:3.22
RUN apk add --no-cache ca-certificates docker-cli docker-compose restic

# Create non-root user
RUN adduser -D -u 1000 libreserv

WORKDIR /app
# Copy backend binary
COPY --from=backend-builder /app/backend/bin/libreserv /app/libreserv
# Copy frontend assets (vite outputs to /repo/sol/server/backend/OS/dist due to outDir: "../backend/OS/dist")
COPY --from=frontend-builder /repo/sol/server/backend/OS/dist /app/OS/dist
# Copy default configs
COPY sol/server/backend/configs /app/configs
# Use example config as default (env vars override specific settings at runtime)
RUN cp /app/configs/libreserv.yaml.example /app/configs/libreserv.yaml

# Ensure data directories are writable by libreserv user
RUN mkdir -p /app/data /app/configs && chown -R libreserv:libreserv /app

USER libreserv

COPY sol/entrypoint.sh /app/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--config", "/app/configs/libreserv.yaml"]

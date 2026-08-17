# Stage 1: Build Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY server/frontend/package*.json ./
RUN npm ci
COPY server/frontend/ ./
# Copy .lore to repo root where frontend expects it
COPY .lore /.lore
RUN npm run build

# Stage 2: Build Backend
FROM golang:1.26-alpine AS backend-builder
RUN apk add --no-cache git make
WORKDIR /app/backend
COPY server/backend/go.mod server/backend/go.sum ./
RUN go mod download
COPY server/backend/ ./
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
# Copy frontend assets (vite outputs to /app/backend/OS/dist due to outDir: "../backend/OS/dist")
COPY --from=frontend-builder /app/backend/OS/dist /app/OS/dist
# Copy default configs
COPY server/backend/configs /app/configs
# Use example config as default (env vars override specific settings at runtime)
RUN cp /app/configs/libreserv.yaml.example /app/configs/libreserv.yaml

# Ensure data directories are writable by libreserv user
RUN mkdir -p /app/data /app/configs && chown -R libreserv:libreserv /app

USER libreserv

COPY entrypoint.sh /app/entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["--config", "/app/configs/libreserv.yaml"]

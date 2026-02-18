# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY server/frontend/package*.json ./
RUN npm install
COPY server/frontend/ ./
# Copy .lore to repo root where frontend expects it
COPY .lore /.lore
RUN npm run build

# Stage 2: Build Backend
FROM golang:1.25-alpine AS backend-builder
RUN apk add --no-cache git make
WORKDIR /app/backend
COPY server/backend/go.mod server/backend/go.sum ./
RUN go mod download
COPY server/backend/ ./
# Inject version info during build
ARG VERSION=dev
RUN VERSION=${VERSION} make build

# Stage 3: Final Image
FROM alpine:3.19
RUN apk add --no-cache ca-certificates docker-cli docker-compose

WORKDIR /app
# Copy backend binary
COPY --from=backend-builder /app/backend/bin/libreserv /app/libreserv
# Copy frontend assets (vite outputs to /app/backend/OS/dist due to outDir: "../backend/OS/dist")
COPY --from=frontend-builder /app/backend/OS/dist /app/OS/dist
# Copy default configs
COPY server/backend/configs /app/configs

EXPOSE 8080
ENTRYPOINT ["/app/libreserv"]
CMD ["--config", "/app/configs/libreserv.yaml"]

# LibreServ Connect — single-layer Dockerfile
# Binary is pre-built on pscB (CGO enabled for go-sqlite3)
# Uses base-debian12 for CA certs (Stripe, provider API calls need HTTPS)
FROM gcr.io/distroless/base-debian12:latest

COPY connect-server /connect-server

USER 1000:1000

ENTRYPOINT ["/connect-server"]

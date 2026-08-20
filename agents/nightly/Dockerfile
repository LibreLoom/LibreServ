# LibreServ Nightly Maintenance Agent — Runtime Image
#
# Builds the container the nightly agent runs in. Contains every runtime the
# repo's CI needs (Go, Node, Rust, Android/Gradle), the dsh CLI + headless
# profile, and a container-runtime socket client so `./ci` can spawn test
# containers against the host's Docker/Podman socket (mounted at runtime).
#
# Build (context = agents/, so ../nightly-maintenance-prompt.md is COPYable):
#   docker build -f agents/nightly/Dockerfile -t libreserv-nightly agents/
#
# Run (see agents/nightly/run-nightly.sh for the full launcher):
#   docker run --rm \
#     -e FORGEJO_TOKEN=... -e AI_PROXY_API_KEY=... \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v libreserv-nightly-state:/state \
#     libreserv-nightly

# Node 22 LTS base: modern node/npm for dsh, plus Debian bookworm for apt.
FROM node:22-bookworm-slim AS base

# ---- system basics ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq make bash \
      # Go CGO toolchain bits (sqlite etc. need gcc + headers)
      gcc g++ libc6-dev pkg-config \
      # node-gyp (node-pty native module inside dsh) needs python + make
      python3 \
      # docker CLI (talks to the mounted host socket; `./ci` discovers it)
      docker.io \
      # podman CLI (needed by the podman-build CI test which runs on "host")
      podman \
      # misc
      openssh-client time \
    && rm -rf /var/lib/apt/lists/*

# ---- Go 1.26 (backend, connect, ci-source, companion) ----
ARG GO_VERSION=1.26.5
ENV GOTOOLCHAIN=local
RUN curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}"

# ---- Rust 1.96 (luna workspace) ----
ARG RUST_VERSION=1.96.0
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:${PATH}"
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y \
      --default-toolchain "${RUST_VERSION}" \
      --profile minimal \
      --component clippy \
      --component rustfmt \
    && rustc --version && cargo --version

# ---- Android SDK (luna/mobile gradle tests) ----
# cmdline-tools, platform 34, build-tools; licenses pre-accepted.
ENV ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && curl -fsSLo /tmp/cmdtools.zip "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
    && unzip -q /tmp/cmdtools.zip -d "${ANDROID_HOME}/cmdline-tools" \
    && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm /tmp/cmdtools.zip \
    && yes | "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 \
    && "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" \
         "platforms;android-34" "build-tools;34.0.0" "platform-tools" >/dev/null \
    && rm -rf "${ANDROID_HOME}/.temp"

# ---- dsh CLI (the agent runtime) ----
# The CLI's own deps include @deepseek-ai/dsh-base and dsh-headless bundles;
# profile package.json references resolve from the global install (profiles need
# no per-profile node_modules, matching the host's headless profile layout).
RUN npm install -g --no-fund --no-audit @deepseek-ai/dsh@0.1.0-rc.8
RUN dsh --version

# ---- agent home + headless profile ----
ENV DSH_HOME=/opt/dsh
COPY nightly/dsh-home/ "${DSH_HOME}/"

# ---- repo clone + entrypoint ----
ENV REPO_URL="https://gt.plainskill.net/LibreLoom/LibreServ.git" \
    AGENT_HOME=/opt/agent
COPY nightly-maintenance-prompt.md "${AGENT_HOME}/prompt.md"
COPY nightly/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

FROM node:22-bookworm-slim
ARG GO_VERSION=1.26.5
ARG RUST_VERSION=1.96.0
ARG RUNNER_VERSION=13.0.0
ARG DSH_VERSION=0.1.0-rc.8
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 make bash gcc libc6-dev && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz
ENV PATH="/usr/local/go/bin:${PATH}" GOTOOLCHAIN=local
COPY agents/atlas-runner/install-tools.sh /tmp/install-tools.sh
RUN sh /tmp/install-tools.sh
COPY agents/atlas-bot /opt/atlas-bot
COPY agents/atlas-runner/config.yaml /opt/atlas-runner/config.yaml
COPY agents/atlas-runner/entrypoint.sh /usr/local/bin/atlas-entrypoint.sh
RUN chmod 0755 /usr/local/bin/atlas-entrypoint.sh && cp -a /opt/atlas-bot/dsh-home/. /opt/dsh/ && chown -R atlas:atlas /data /opt/dsh /opt/atlas-bot /home/atlas
ENV DSH_HOME=/opt/dsh ATLAS_COOK=/opt/atlas-bot/cook.sh HOME=/home/atlas
USER atlas
WORKDIR /home/atlas
ENTRYPOINT ["/usr/local/bin/atlas-entrypoint.sh"]

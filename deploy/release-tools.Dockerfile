FROM docker:29.6.2-cli AS docker
FROM node:24.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
ADD --checksum=sha256:424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64 /usr/local/bin/cosign
RUN chmod 755 /usr/local/bin/cosign && git config --system --add safe.directory /repo
WORKDIR /repo
ENTRYPOINT ["node", "scripts/release/executor.mjs"]

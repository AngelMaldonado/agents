# A task's mini-computer: Linux, a shell, Chromium driven by agent-browser, and pi in RPC mode.
# Built on reko-3: just sandbox build
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep tini python3 xvfb xauth \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 \
      libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 \
      libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnss3-tools \
      libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 libgbm1 \
      fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Pinned: the backend speaks pi's RPC protocol and agent-browser's stream protocol.
ARG PI_VERSION=1.4.0
ARG AGENT_BROWSER_VERSION=0.39.2
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
    && npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && npm cache clean --force

# Chrome for agent-browser, readable by the unprivileged user.
RUN HOME=/tmp/abhome agent-browser install \
    && mv /tmp/abhome/.agent-browser/browsers /opt/browsers && rm -rf /tmp/abhome \
    && chmod -R a+rX /opt/browsers \
    && ln -s "$(find /opt/browsers -name chrome -type f -perm -u+x | head -1)" /usr/local/bin/buyer-chrome

RUN useradd -m -u 1001 -s /bin/bash agent
COPY bin/ /usr/local/bin/
COPY supervisor.mjs /opt/buyer/supervisor.mjs

# --no-sandbox: the container is the sandbox (no new privileges, all capabilities dropped).
# Headed on a virtual display (agent-browser starts Xvfb) and without the automation flag:
# headless Chrome says "HeadlessChrome" and webdriver=true, and sites like MercadoLibre block it.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/buyer-chrome \
    AGENT_BROWSER_HEADED=1 \
    AGENT_BROWSER_ARGS=--no-sandbox,--disable-blink-features=AutomationControlled,--lang=es-MX \
    AGENT_BROWSER_STREAM_PORT=9223 \
    AGENT_BROWSER_PLUGINS='[{"name":"buyer","command":"buyer-vault","capabilities":["credential.read"]}]' \
    TZ=America/Mexico_City \
    LANG=C.UTF-8

USER agent
WORKDIR /home/agent
ENTRYPOINT ["tini", "--", "node", "/opt/buyer/supervisor.mjs"]

# A task's mini-computer: Linux, a shell, Chromium driven by agent-browser, and pi in RPC mode.
# Dev (arm64, reko-2): just sandbox build. Prod (amd64) is built on reko-3 by the release.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep tini python3 xvfb xauth x11vnc openbox tint2 xterm x11-xserver-utils jgmenu wmctrl htop pcmanfm librsvg2-common hsetroot mousepad \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 \
      libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 libcairo2 \
      libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnss3-tools \
      libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 libxshmfence1 libgbm1 \
      fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Pinned: the backend speaks pi's RPC protocol and agent-browser's stream protocol.
ARG PI_VERSION=1.4.0
LABEL io.cuby.agents.pi.version="${PI_VERSION}"
ARG AGENT_BROWSER_VERSION=0.39.2
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} \
    && npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && npm cache clean --force

# Chrome for agent-browser, readable by the unprivileged user. Chrome for Testing has no Linux
# arm64 build, so the arm64 image (dev on reko-2) uses Debian's Chromium; amd64 (prod) keeps Chrome.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) \
        HOME=/tmp/abhome agent-browser install; \
        mv /tmp/abhome/.agent-browser/browsers /opt/browsers && rm -rf /tmp/abhome; \
        chmod -R a+rX /opt/browsers; \
        ln -s "$(find /opt/browsers -name chrome -type f -perm -u+x | head -1)" /usr/local/bin/agents-chrome ;; \
      arm64) \
        apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; \
        ln -s /usr/bin/chromium /usr/local/bin/agents-chrome ;; \
      *) echo 'Unsupported browser architecture' >&2; exit 1 ;; \
    esac; \
    test -x /usr/local/bin/agents-chrome

RUN useradd -m -u 1001 -s /bin/bash agent
# The agent's state volume mounts here; an empty volume takes this owner on its first mount.
RUN mkdir -p /home/agent/state && chown agent:agent /home/agent/state
# pi's find requires --no-require-git (fd >=8.7); Bookworm has 8.6. Pin and verify
# the upstream release at build time, never download executables during a run.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sha=2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14 ;; \
      arm64) arch=aarch64; sha=996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b ;; \
      *) echo 'Unsupported fd architecture' >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --connect-timeout 10 --max-time 90 "https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-${arch}-unknown-linux-musl.tar.gz" -o /tmp/fd.tar.gz; \
    echo "$sha  /tmp/fd.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/fd.tar.gz -C /tmp; \
    install -m 0755 "/tmp/fd-v10.3.0-${arch}-unknown-linux-musl/fd" /usr/local/bin/fd; \
    rm -rf /tmp/fd.tar.gz "/tmp/fd-v10.3.0-${arch}-unknown-linux-musl"
# uv installs the Python CLI tools an owner approves for an agent (harness installs), into the agent's
# volume at start. Pinned and verified like fd.
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sha=5d61f26b6c7213779eda90edc6971ea6b0b796bfb8d49a574c8ad69b59838548 ;; \
      arm64) arch=aarch64; sha=819692e404d23e5aae6bc44c0e260f1f5492fd1910ab4693b2c650f926dbe800 ;; \
      *) echo 'Unsupported uv architecture' >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 --connect-timeout 10 --max-time 90 "https://github.com/astral-sh/uv/releases/download/0.13.6/uv-${arch}-unknown-linux-musl.tar.gz" -o /tmp/uv.tar.gz; \
    echo "$sha  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    install -m 0755 "/tmp/uv-${arch}-unknown-linux-musl/uv" /usr/local/bin/uv; \
    rm -rf /tmp/uv.tar.gz "/tmp/uv-${arch}-unknown-linux-musl"
COPY bin/ /usr/local/bin/
# The owner's desktop (#27): one workspace and no Debian menu; agents-theme generates the bar, both
# menus and the window theme from this base at every start.
COPY desktop/ /opt/agents/desktop/
# In the owner's terminals `pi` opens their agent (agents-pi); the agent itself runs the real pi.
RUN mkdir -p /opt/agents/owner-bin && ln -s /usr/local/bin/agents-pi /opt/agents/owner-bin/pi
RUN sed -i 's#<number>4</number>#<number>1</number>#; s#<file>/var/lib/openbox/debian-menu.xml</file>##' /etc/xdg/openbox/rc.xml \
    && cp /opt/agents/desktop/mimeapps.list /etc/xdg/mimeapps.list
COPY supervisor.mjs self-maintenance.mjs harness*.mjs harness*.ts /opt/agents/
# Resolve pi's pinned TypeBox/API dependencies for the platform-owned extension (no npm at runtime).
RUN ln -s /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules /opt/agents/node_modules

# --no-sandbox: the container is the sandbox (no new privileges, all capabilities dropped).
# --no-proxy-server: Chrome browses directly; the egress proxy of API keys (#24) is only for pi's tools.
# Headed on a virtual display (the supervisor's Xvfb :99 with openbox, which the owner's desktop view
# shows through x11vnc; agent-browser starts its own only if that one is missing) and without the automation flag:
# headless Chrome says "HeadlessChrome" and webdriver=true, and sites like MercadoLibre block it.
# The profile (cookies, logins, storage) lives in the agent's volume; its cache does not.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/agents-chrome \
    AGENT_BROWSER_HEADED=1 \
    AGENT_BROWSER_PROFILE=/home/agent/state/browser \
    AGENT_BROWSER_ARGS=--no-sandbox,--no-proxy-server,--disable-blink-features=AutomationControlled,--lang=es-MX,--disk-cache-dir=/tmp/chrome-cache \
    AGENT_BROWSER_STREAM_PORT=9223 \
    AGENT_BROWSER_STREAM_QUALITY=60 \
    AGENT_BROWSER_PLUGINS='[{"name":"agents","command":"agents-vault","capabilities":["credential.read"]}]' \
    TZ=America/Mexico_City \
    LANG=C.UTF-8

USER agent
WORKDIR /home/agent
ENTRYPOINT ["tini", "--", "node", "/opt/agents/supervisor.mjs"]

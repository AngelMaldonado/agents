#!/bin/sh
# The CA (key + certificate, PEM) comes from the environment, never from the image: the sandboxes
# trust its certificate, so the key is the stack's secret (dev: data/dev/proxy, from just dev init).
set -eu
: "${AGENTS_PROXY_CA_PEM:?missing the proxy CA (key + certificate)}"
: "${AGENTS_BACKEND_URL:?missing the backend URL}"
: "${AGENTS_PROXY_SECRET:?missing the proxy secret}"
conf=/tmp/mitmproxy
mkdir -p "$conf"
umask 077
printf '%s\n' "$AGENTS_PROXY_CA_PEM" > "$conf/mitmproxy-ca.pem"
unset AGENTS_PROXY_CA_PEM
exec mitmdump --listen-port 8080 --set confdir="$conf" --set block_global=false \
	--set connection_strategy=lazy --set flow_detail=0 -s /opt/agents-proxy/agents.py

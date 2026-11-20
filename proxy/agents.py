"""mitmproxy addon: the egress proxy of a person's API keys (#24, Bubble agents).

Every CONNECT (and plain-HTTP request) must carry the run's credential (Proxy-Authorization:
Basic run:<token>); without a live run behind it the answer is 407. For that run the backend lists
which placeholders stand for which values towards which domains (GET /internal/proxy/rules, with
this proxy's own secret: a run's token alone never reads a value). Only connections to those
domains are opened (TLS with Agents' CA); everything else passes through as a plain tunnel.

With AGENTS_PROXY_INTERNAL_UPSTREAM (production: Traefik, on a second network) it also decides where
each connection may go: the admin's internal services to Traefik, anything else only to public
addresses (egress.py).
"""

import asyncio
import json
import os
import socket
import threading
import time
import urllib.request

from mitmproxy import http, tls
from mitmproxy.proxy.server_hooks import ServerConnectionHookData

from egress import internal_target, pick_public
from swap import intercept, run_token, swap_headers

BACKEND = os.environ["AGENTS_BACKEND_URL"].rstrip("/")
SECRET = os.environ["AGENTS_PROXY_SECRET"]
UPSTREAM = os.environ.get("AGENTS_PROXY_INTERNAL_UPSTREAM", "").strip() or None
TTL = 20  # seconds a run's rules are reused; a grant or revocation applies from the next run anyway

_cache: dict[str, tuple[float, list | None]] = {}
_lock = threading.Lock()
_tokens: dict[str, str] = {}  # client connection id -> run token (from its CONNECT)
_internal: list[str] = []  # the admin's internal services, as the backend sent them last


def rules_for(token: str):
    now = time.time()
    with _lock:
        hit = _cache.get(token)
        if hit and hit[0] > now:
            return hit[1]
    request = urllib.request.Request(
        f"{BACKEND}/internal/proxy/rules",
        headers={"x-agents-proxy-secret": SECRET, "x-agents-run-token": token},
    )
    global _internal
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = json.load(response)
        rules = payload["rules"]
        internal = payload.get("internal")
        if isinstance(internal, list):
            _internal = [h for h in internal if isinstance(h, str)]
    except Exception:
        rules = None  # not a live run, or the backend is unreachable: no keys, no proxying
    with _lock:
        _cache[token] = (now + (TTL if rules is not None else 3), rules)
    return rules


def _deny(flow: http.HTTPFlow):
    flow.response = http.Response.make(407, b"", {"Proxy-Authenticate": 'Basic realm="agents"'})


class Agents:
    def http_connect(self, flow: http.HTTPFlow):
        token = run_token(flow.request.headers.get("Proxy-Authorization"))
        if not token or rules_for(token) is None:
            return _deny(flow)
        _tokens[flow.client_conn.id] = token
        flow.request.headers.pop("Proxy-Authorization", None)

    def tls_clienthello(self, data: tls.ClientHelloData):
        token = _tokens.get(data.context.client.id)
        host = data.client_hello.sni or (data.context.server.address or ("",))[0]
        if not token or not intercept(rules_for(token), host):
            data.ignore_connection = True  # a plain tunnel: not opened, not touched

    def requestheaders(self, flow: http.HTTPFlow):
        token = _tokens.get(flow.client_conn.id)
        if token is None:  # plain HTTP through the proxy: the credential comes with each request
            token = run_token(flow.request.headers.get("Proxy-Authorization"))
            if not token or rules_for(token) is None:
                return _deny(flow)
        flow.request.headers.pop("Proxy-Authorization", None)
        swapped = swap_headers(list(flow.request.headers.items(multi=True)), flow.request.pretty_host, rules_for(token))
        for name in {k for k, _ in swapped}:
            del flow.request.headers[name]
        for name, value in swapped:
            flow.request.headers.add(name, value)

    async def server_connect(self, data: ServerConnectionHookData):
        # Only with a leg on Traefik's network; on the locked bridge alone the host's firewall decides.
        if not UPSTREAM or not data.server.address:
            return
        host, port = data.server.address[0], int(data.server.address[1])
        target = internal_target(host, port, _internal, UPSTREAM)
        if target is None:
            try:
                infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
            except OSError as err:
                data.server.error = f"no se pudo resolver {host}: {err}"
                return
            address = pick_public([info[4][0] for info in infos])
            if address is None:
                data.server.error = f"destino no público bloqueado: {host} (Administración → Servicios internos)"
                return
            target = (address, port)
        # TLS towards it (when a key opens it) still names the host the sandbox asked for.
        if data.server.sni is None and target[0] != host:
            data.server.sni = host
        data.server.address = target

    def client_disconnected(self, client):
        _tokens.pop(client.id, None)


addons = [Agents()]

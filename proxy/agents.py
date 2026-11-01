"""mitmproxy addon: the egress proxy of a person's API keys (#24, Bubble agents).

Every CONNECT (and plain-HTTP request) must carry the run's credential (Proxy-Authorization:
Basic run:<token>); without a live run behind it the answer is 407. For that run the backend lists
which placeholders stand for which values towards which domains (GET /internal/proxy/rules, with
this proxy's own secret: a run's token alone never reads a value). Only connections to those
domains are opened (TLS with Agents' CA); everything else passes through as a plain tunnel.
"""

import json
import os
import threading
import time
import urllib.request

from mitmproxy import http, tls

from swap import intercept, run_token, swap_headers

BACKEND = os.environ["AGENTS_BACKEND_URL"].rstrip("/")
SECRET = os.environ["AGENTS_PROXY_SECRET"]
TTL = 20  # seconds a run's rules are reused; a grant or revocation applies from the next run anyway

_cache: dict[str, tuple[float, list | None]] = {}
_lock = threading.Lock()
_tokens: dict[str, str] = {}  # client connection id -> run token (from its CONNECT)


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
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            rules = json.load(response)["rules"]
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

    def client_disconnected(self, client):
        _tokens.pop(client.id, None)


addons = [Agents()]

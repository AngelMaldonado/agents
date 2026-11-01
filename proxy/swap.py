"""The egress proxy's pure logic (#24): no mitmproxy here, so it is tested with plain python3.

A run's sandbox reaches this proxy as http://run:<token>@proxy:8080. The backend tells, for that
token, which placeholders (agk_...) stand for which values and towards which domains. In a request
to one of those domains, a placeholder in a header becomes its value; HTTP Basic is decoded,
swapped and re-encoded (git over HTTPS sends tokens that way). Anywhere else nothing changes.
"""

import base64

Rule = dict  # {"domains": [str], "placeholder": str, "value": str}


def run_token(proxy_authorization: str | None) -> str | None:
    """The run's token from `Proxy-Authorization: Basic base64(run:<token>)`."""
    if not proxy_authorization or not proxy_authorization.lower().startswith("basic "):
        return None
    try:
        user, _, password = base64.b64decode(proxy_authorization[6:].strip()).decode().partition(":")
    except Exception:
        return None
    return password if user == "run" and password else None


def domain_matches(host: str, domain: str) -> bool:
    """Exact host, or a subdomain for `*.example.com` (not example.com itself)."""
    h = host.lower().rstrip(".")
    if domain.startswith("*."):
        return h.endswith(domain[1:]) and len(h) > len(domain) - 1
    return h == domain


def rules_for_host(rules: list[Rule] | None, host: str) -> list[Rule]:
    return [r for r in (rules or []) if any(domain_matches(host, d) for d in r["domains"])]


def intercept(rules: list[Rule] | None, host: str) -> bool:
    """Open the TLS of this connection only when some key may go to its host."""
    return bool(rules_for_host(rules, host))


def _swap(text: str, rules: list[Rule]) -> str:
    for r in rules:
        if r["placeholder"] in text:
            text = text.replace(r["placeholder"], r["value"])
    return text


def swap_header(name: str, value: str, rules: list[Rule]) -> str:
    """A header's value with the placeholders of these rules replaced (Basic decoded first)."""
    if not rules:
        return value
    if name.lower() in ("authorization", "proxy-authorization") and value[:6].lower() == "basic ":
        try:
            decoded = base64.b64decode(value[6:].strip()).decode()
        except Exception:
            return _swap(value, rules)
        swapped = _swap(decoded, rules)
        if swapped != decoded:
            return value[:6] + base64.b64encode(swapped.encode()).decode()
        return value
    return _swap(value, rules)


def swap_headers(headers: list[tuple[str, str]], host: str, rules: list[Rule] | None) -> list[tuple[str, str]]:
    applicable = rules_for_host(rules, host)
    return [(k, swap_header(k, v, applicable)) for k, v in headers]

"""Where the egress proxy may connect (no mitmproxy here, so it is tested with plain python3).

The sandboxes' bridge is locked away from the LAN by the host's firewall, and so is this proxy's
leg on it. In production the proxy has a second leg on Traefik's network, which is not locked: so
it decides here, for every upstream connection, what that leg may be used for.

- A host in the admin's «Servicios internos» (internal hosts, on ports 80/443) goes to Traefik
  (AGENTS_PROXY_INTERNAL_UPSTREAM), whatever its DNS says: services like sonos.cubytest.space
  resolve to the LAN, which no sandbox may reach.
- Anything else must resolve only to public addresses, and the proxy connects to the address it
  checked (no second lookup for a DNS rebinding to slip through). Traefik's network, the other
  containers on it, the LAN, the tailnet, loopback and link-local stay out.
"""

import ipaddress

INTERNAL_PORTS = (80, 443)


def normalize_host(host: str) -> str:
    return host.lower().rstrip(".")


def internal_target(host: str, port: int, internal_hosts, upstream: str | None):
    """(upstream, port) when this connection goes to an internal service through Traefik; else None."""
    if not upstream or port not in INTERNAL_PORTS:
        return None
    return (upstream, port) if normalize_host(host) in {normalize_host(h) for h in internal_hosts or ()} else None


def is_public(address: str) -> bool:
    """Only globally routable unicast addresses: not private, CGNAT (the tailnet), loopback, link-local…"""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def pick_public(addresses: list[str]) -> str | None:
    """The address to connect to, IPv4 first; None if there is none or any of them is not public.

    All of them must be public: a name that answers with one public and one private address is
    refused, not half-used.
    """
    unique = list(dict.fromkeys(addresses))
    if not unique or not all(is_public(a) for a in unique):
        return None
    v4 = [a for a in unique if ":" not in a]
    return (v4 or unique)[0]

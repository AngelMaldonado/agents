#!/usr/bin/env bash
# Egress check for the sandbox network, run inside a container on it (the deploy scripts run it on the production sandbox network).
# The rule itself lives in ~/dev/work/reko-3: docker_egress_lock_interfaces + firewall_deny_interfaces.
# The LAN and tailnet addresses are reko-3's own.
set -u
hex=$(awk '$2=="00000000"{print $3; exit}' /proc/net/route)
gw=$(printf '%d.%d.%d.%d' "0x${hex:6:2}" "0x${hex:4:2}" "0x${hex:2:2}" "0x${hex:0:2}")
fail=0
check() { # expected label host port
	if timeout 4 bash -c "</dev/tcp/$3/$4" 2>/dev/null; then got=open; else got=closed; fi
	if [ "$got" = "$1" ]; then mark=ok; else mark=FAIL; fail=1; fi
	printf '%-4s %-6s  %-32s %s:%s\n' "$mark" "$got" "$2" "$3" "$4"
}
check open 'internet (DNS + TCP)' example.com 443
check open 'backend, same bridge' "${SERVER:?}" 8787
check closed 'reko-3 LAN IP (Traefik)' 192.168.20.250 443
check closed 'LAN router' 192.168.20.1 53
check closed 'reko-3 tailnet IP (SSH)' 100.64.0.17 22
check closed 'host via gateway (SSH)' "$gw" 22
check closed 'host via gateway (dockerd)' "$gw" 9323
check closed 'cloud metadata' 169.254.169.254 80
exit $fail

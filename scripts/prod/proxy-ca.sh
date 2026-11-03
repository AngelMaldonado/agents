#!/usr/bin/env bash
# `just prod proxyca`: the production egress proxy's CA and its shared secret with the server, written to
# the gitignored .env.production (0600) only if they are not there yet. Nothing is printed but their names:
# copy them to the Komodo stack `agents` → Environment without the PROD_ part of the name.
set -euo pipefail
cd "$(dirname "$0")/../.."
file=.env.production
umask 077
touch "$file"
chmod 600 "$file"
if grep -q '^AGENTS_PROD_PROXY_CA_PEM_B64=' "$file"; then
	echo "$file ya tiene la CA del proxy de producción; no se genera otra (sus agentes ya confían en ella)."
else
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT
	openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Agents prod egress proxy" \
		-keyout "$tmp/ca.key" -out "$tmp/ca.crt" >/dev/null 2>&1
	{
		printf 'AGENTS_PROD_PROXY_CA_PEM_B64=%s\n' "$(cat "$tmp/ca.key" "$tmp/ca.crt" | base64 | tr -d '\n')"
		printf 'AGENTS_PROD_PROXY_CA_CERT_B64=%s\n' "$(base64 < "$tmp/ca.crt" | tr -d '\n')"
	} >> "$file"
	echo "CA del proxy generada (10 años) en $file."
fi
if ! grep -q '^AGENTS_PROD_PROXY_SECRET=' "$file"; then
	printf 'AGENTS_PROD_PROXY_SECRET=%s\n' "$(openssl rand -hex 24)" >> "$file"
	echo "Secreto del proxy generado en $file."
fi
cat <<'MSG'
Cópialos a Komodo → stack agents → Environment, con estos nombres:
  AGENTS_PROXY_CA_PEM_B64   ← AGENTS_PROD_PROXY_CA_PEM_B64   (secreto: la llave de la CA)
  AGENTS_PROXY_CA_CERT_B64  ← AGENTS_PROD_PROXY_CA_CERT_B64  (público: el certificado)
  AGENTS_PROXY_SECRET       ← AGENTS_PROD_PROXY_SECRET       (secreto)
Ábrelo tú (p. ej. en tu editor); este comando no muestra los valores.
MSG

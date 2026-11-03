// The egress proxy's settings (#24): production passes the CA certificate in base64 (one line in the
// stack's Environment), dev as PEM; without URL and certificate the instance has no proxy.
import { afterEach, expect, test } from 'bun:test';
import { proxyConfig } from './accesses';

const saved = { ...process.env };
afterEach(() => {
	for (const k of ['AGENTS_PROXY_URL', 'AGENTS_PROXY_CA_CERT', 'AGENTS_PROXY_CA_CERT_B64']) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

test('the proxy certificate comes as PEM or as base64, and both URL and certificate are needed', () => {
	const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';
	delete process.env.AGENTS_PROXY_CA_CERT;
	process.env.AGENTS_PROXY_URL = 'http://agents-prod-proxy:8080';
	process.env.AGENTS_PROXY_CA_CERT_B64 = Buffer.from(pem).toString('base64');
	expect(proxyConfig()).toEqual({ url: 'http://agents-prod-proxy:8080', ca: pem });
	process.env.AGENTS_PROXY_CA_CERT = 'dev pem';
	expect(proxyConfig()?.ca).toBe('dev pem');
	delete process.env.AGENTS_PROXY_URL;
	expect(proxyConfig()).toBeNull();
});

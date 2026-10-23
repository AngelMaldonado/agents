// Secrets at rest: AES-256-GCM with BUYER_MASTER_KEY (32 bytes, base64), which never lives in
// the database. Provider keys and site logins are write-only: nothing decrypts them for a person,
// only for CLIProxyAPI's config and for a granted sandbox login.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function masterKey() {
	const raw = process.env.BUYER_MASTER_KEY;
	if (!raw) throw new Error('BUYER_MASTER_KEY is not set');
	const key = Buffer.from(raw, 'base64');
	if (key.length !== 32) throw new Error('BUYER_MASTER_KEY must be 32 bytes in base64');
	return key;
}

/** v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function seal(plain: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return ['v1', iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function open(sealed: string) {
	const [v, iv, tag, body] = sealed.split('.');
	if (v !== 'v1') throw new Error('unknown secret format');
	const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export function checkMasterKey() {
	masterKey();
}

// Verifica los payloads Cosign del OCI local con la llave pública fijada; sin login, firma ni Rekor.
import fs from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
export function verifyPayload(key, body, signature, expected) {
	const publicKey = createPublicKey(key);
	if (publicKey.asymmetricKeyType !== 'ec' || !verify('sha256', body, publicKey, Buffer.from(signature, 'base64')))
		throw new Error('Firma inválida');
	const p = JSON.parse(body);
	if (
		p.critical?.type !== 'cosign container image signature' ||
		p.critical?.image?.['docker-manifest-digest'] !== expected.digest ||
		p.critical?.identity?.['docker-reference'] !== expected.repository ||
		p.optional?.git_sha !== expected.sha ||
		p.optional?.version !== expected.version
	)
		throw new Error('Firma válida pero identidad de release distinta');
	return true;
}
export function verifyRegistry(key) {
	if (
		createHash('sha256').update(key).digest('hex') !==
		'306102f7485320db8a37e90babb847b7f99e5910775d292d6a44801736475859'
	)
		throw new Error('Llave pública distinta de la fijada');
	const images = [
		['agents-app', '8a8d92f6ad22e024e3defba54261e903e60b24e43a18f5efd0d1e13a534916a8'],
		['agents-sandbox', '04771072a9d1064e52c034b1f59a1db7c46f695c760568cc9af76d20d5bebd40'],
	];
	return images.map(([name, hash]) => {
		const root = `/registry/cuby/${name}`;
		const blob = (digest) => {
			if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Digest inválido');
			const bytes = fs.readFileSync(`${root}/blobs/sha256/${digest.slice(7)}`);
			if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new Error('Blob corrupto');
			return bytes;
		};
		const index = JSON.parse(fs.readFileSync(`${root}/index.json`));
		const tag = `sha256-${hash}.sig`;
		const signatures = index.manifests.filter((d) => d.annotations?.['org.opencontainers.image.ref.name'] === tag);
		const expected = {
			digest: `sha256:${hash}`,
			repository: `registry.cubytest.space/cuby/${name}`,
			sha: 'f21d03be79c550e2fc77f42a3d1f3a6bb478f5a3',
			version: '0.0.1-beta',
		};
		let verified = 0;
		for (const descriptor of signatures) {
			const manifest = JSON.parse(blob(descriptor.digest));
			for (const layer of manifest.layers ?? []) {
				const signature = layer.annotations?.['dev.cosignproject.cosign/signature'];
				if (signature && verifyPayload(key, blob(layer.digest), signature, expected)) verified++;
			}
		}
		if (!verified) throw new Error('No hay firma verificable');
		// El digest firmado puede ser un índice; comprobar también config/plataforma/etiquetas.
		let manifest = JSON.parse(blob(expected.digest));
		if (manifest.manifests) {
			const platform = manifest.manifests.find(
				(d) => d.platform?.os === 'linux' && d.platform?.architecture === 'amd64',
			);
			if (!platform) throw new Error('Plataforma ausente');
			manifest = JSON.parse(blob(platform.digest));
		}
		const config = JSON.parse(blob(manifest.config.digest));
		if (
			config.os !== 'linux' ||
			config.architecture !== 'amd64' ||
			config.config?.Labels?.['org.opencontainers.image.revision'] !== expected.sha ||
			config.config?.Labels?.['org.opencontainers.image.version'] !== expected.version
		)
			throw new Error('Configuración de imagen divergente');
		return {
			...expected,
			signaturesVerified: verified,
			algorithm: 'ECDSA-SHA256',
			platform: 'linux/amd64',
			manifestConfigAndPayloadHashesVerified: true,
		};
	});
}
if (process.env.AGENTS_SIGNATURE_CHECK === 'true')
	console.log(JSON.stringify(verifyRegistry(process.env.AGENTS_PUBLIC_KEY)));

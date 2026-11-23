// `just release [<sha de 12> | vX.Y.Z-beta]`: todo lo dispara este comando, desde esta Mac; nada escucha pushes ni webhooks.
//
//   just release          revisa wip, calcula la versión (la siguiente beta después del último tag vX.Y.Z-beta), corre
//                         las revisiones rápidas aquí, manda el commit (git archive) al Docker de
//                         reko-5, que compila las tres imágenes y las sube a Zot con :<sha12>; en reko-5 corre las
//                         pruebas con base y los dos E2E contra esas mismas imágenes (scripts/ci/e2e.sh); sube wip;
//                         las firma el stack de un solo uso «agents-firma» de Komodo (la llave de cosign vive en las
//                         variables de Komodo y sólo entra a ese contenedor); las verifica contra release/cosign.pub,
//                         mueve :beta, sube deploy/agents.compose.yaml al stack «agents», despliega y espera a que
//                         /healthz diga el commit; al final crea y sube el tag anotado v<versión> en ese commit.
//   just release <sha12>  vuelve a una versión ya publicada (también por su tag: just release v0.0.9-beta): verifica sus
//                         firmas, mueve :beta y despliega su compose.
//
// La API key de Komodo sale de 1Password (bóveda Cuby, ítem «Agents Release»: campos key y secret), sólo a memoria.
// Para no usar 1Password: AGENTS_RELEASE_KOMODO_KEY y _SECRET en el entorno. Sólo cambia el compose del stack: su
// Environment (los secretos de producción) no se lee ni se toca.
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

const RAMA = 'wip';
const CONTEXTO = 'reko-5';
const REGISTRY = 'registry.cubytest.space/cuby';
const STACK = 'agents';
const STACK_FIRMA = 'agents-firma';
const URL_PROD = 'https://agents.cubytest.space';
const KOMODO = 'https://komodo.cubytest.space';
const OP = { boveda: 'Cuby', item: 'Agents Release' };
// La red de las pruebas en reko-5 usa este bridge: el bloqueo de salida del host lo cubre (sin LAN ni host).
const BRIDGE_PRUEBAS = 'agents-dev-sbx';
// La variante -dev trae shell (/busybox/sh) y base64: la llave llega en base64 desde Komodo.
const COSIGN = 'ghcr.io/sigstore/cosign/cosign:v3.1.4-dev';
// Registry privado: sin Rekor (como hasta ahora). La firma, la llave esperada, el digest y el commit sí se validan.
const FIRMAR =
	'--use-signing-config=false --new-bundle-format=false --registry-referrers-mode=legacy --tlog-upload=false';
const VERIFICAR = '--new-bundle-format=false --insecure-ignore-tlog=true';

/** `arbol`: la carpeta del repo que es su contexto de build (git archive <sha>:<arbol>). */
const IMAGENES = [
	{ nombre: 'agents-app', arbol: '' },
	{ nombre: 'agents-sandbox', arbol: 'sandbox' },
	{ nombre: 'agents-proxy', arbol: 'proxy' },
] as const;
type Nombre = (typeof IMAGENES)[number]['nombre'];

const paso = (t: string) => console.log(`\n\x1b[1m▸ ${t}\x1b[0m`);
const falla = (t: string): never => {
	console.error(`\n\x1b[31m✗ ${t}\x1b[0m`);
	process.exit(1);
};

// ------------------------------------------------------------------ Komodo

async function credenciales(): Promise<{ llave: string; secreto: string }> {
	const { AGENTS_RELEASE_KOMODO_KEY: llave, AGENTS_RELEASE_KOMODO_SECRET: secreto } = process.env;
	if (llave && secreto) return { llave, secreto };
	const r = await $`op item get ${OP.item} --vault ${OP.boveda} --format=json`.quiet().nothrow();
	if (r.exitCode !== 0)
		return falla(`No pude leer «${OP.item}» de 1Password (bóveda ${OP.boveda}). ¿Está \`op\` con sesión?`);
	const campos = Object.fromEntries(
		(JSON.parse(r.stdout.toString()).fields as { label: string; value?: string }[]).map((f) => [f.label, f.value]),
	);
	if (!campos.key || !campos.secret) return falla(`El ítem «${OP.item}» de 1Password necesita los campos key y secret`);
	return { llave: campos.key, secreto: campos.secret };
}

let acceso: { llave: string; secreto: string } | null = null;
const tapar = (t: string) => (acceso ? [acceso.llave, acceso.secreto].reduce((x, s) => x.split(s).join('[…]'), t) : t);

async function komodo(categoria: 'read' | 'write' | 'execute', type: string, params: Record<string, unknown>) {
	acceso ??= await credenciales();
	const r = await fetch(`${KOMODO}/${categoria}`, {
		method: 'POST',
		signal: AbortSignal.timeout(30_000),
		headers: { 'content-type': 'application/json', 'x-api-key': acceso.llave, 'x-api-secret': acceso.secreto },
		body: JSON.stringify({ type, params }),
	});
	if (!r.ok) falla(`Komodo ${type}: HTTP ${r.status} ${tapar((await r.text()).split('\n')[0]!.slice(0, 200))}`);
	return (await r.json()) as Record<string, unknown>;
}

/** Ejecuta en Komodo y espera a que termine, mostrando sus logs. */
async function ejecutar(type: string, params: Record<string, unknown>) {
	let u = await komodo('execute', type, params);
	const id = (u.id ?? (u._id as { $oid?: string })?.$oid) as string;
	const vistos = new Set<string>();
	for (let i = 0; i < 600; i++) {
		for (const log of (u.logs as { stage?: string; stdout?: string; stderr?: string }[] | undefined) ?? []) {
			const t = tapar(`[${log.stage ?? type}] ${log.stdout ?? ''}${log.stderr ?? ''}`.trim());
			if (!vistos.has(t)) {
				vistos.add(t);
				console.log(t);
			}
		}
		if (u.status === 'Complete')
			return u.success === true
				? u
				: falla(`Komodo ${type} falló (ejecución ${id}); los logs están arriba y en Komodo`);
		await Bun.sleep(2000);
		u = await komodo('read', 'GetUpdate', { id });
	}
	return falla(`Komodo ${type} no terminó en 20 minutos (ejecución ${id}); revísala en Komodo antes de reintentar`);
}

/** Antes de diez minutos de compilar y probar: que la llave exista y vea los dos stacks que va a usar. */
async function revisarKomodo() {
	paso('Revisando el acceso a Komodo');
	for (const stack of [STACK, STACK_FIRMA]) await komodo('read', 'GetStack', { stack });
	console.log(`✓ la API key ve los stacks ${STACK} y ${STACK_FIRMA}`);
}

// ------------------------------------------------------------------ reko-5

/** En reko-5, con su sesión del registry (~/.docker). */
const enReko = (comando: string) => $`ssh ${CONTEXTO} ${comando}`.quiet().nothrow();

async function digestEnRegistry(imagen: string): Promise<string> {
	const r = await enReko(`docker buildx imagetools inspect ${imagen} --format '{{json .Manifest}}'`);
	const d = r.exitCode === 0 ? (JSON.parse(r.stdout.toString()).digest as string) : '';
	return /^sha256:[0-9a-f]{64}$/.test(d) ? d : falla(`No existe ${imagen} en el registry`);
}

/** Compila en el Docker de reko-5 lo que manda git archive (el commit, sin cambios locales) y lo sube con :<sha12>. */
async function compilar(sha: string, version: string): Promise<Record<Nombre, string>> {
	const corto = sha.slice(0, 12);
	paso(`Compilando en ${CONTEXTO} las imágenes de ${corto} (el código va desde esta Mac)`);
	const digests = {} as Record<Nombre, string>;
	await Promise.all(
		IMAGENES.map(async (i) => {
			const meta = join(tmpdir(), `agents-${i.nombre}-${corto}.json`);
			const arbol = i.arbol ? `${sha}:${i.arbol}` : sha;
			// La app dice en /healthz qué commit corre; las tres llevan el commit en sus etiquetas.
			const args =
				i.nombre === 'agents-app'
					? ['--build-arg', `AGENTS_RELEASE_VERSION=${version}`, '--build-arg', `AGENTS_RELEASE_SHA=${sha}`]
					: [];
			const r =
				await $`git archive --format=tar ${arbol} | docker --context ${CONTEXTO} buildx build --platform linux/amd64 --provenance=false --sbom=false --label ${`org.opencontainers.image.revision=${sha}`} --label ${`org.opencontainers.image.version=${version}`} ${args} -f Dockerfile -t ${`${REGISTRY}/${i.nombre}:${corto}`} --push --metadata-file ${meta} --progress plain -`.nothrow();
			if (r.exitCode !== 0) falla(`No compiló ${i.nombre}`);
			const d = JSON.parse(readFileSync(meta, 'utf8'))['containerimage.digest'] as string;
			rmSync(meta, { force: true });
			if (!/^sha256:[0-9a-f]{64}$/.test(d)) falla(`Digest raro para ${i.nombre}: ${d}`);
			digests[i.nombre] = d;
		}),
	);
	for (const i of IMAGENES) console.log(`✓ ${i.nombre}:${corto} → ${digests[i.nombre].slice(0, 19)}…`);
	return digests;
}

/** Las pruebas con base y los dos E2E en reko-5, contra las imágenes que se van a publicar. */
async function probar(sha: string) {
	const corto = sha.slice(0, 12);
	paso(`Pruebas en ${CONTEXTO}: servidor contra PostgreSQL, imagen de la app, y E2E de diseño y de compartir`);
	const r = await $`bash scripts/ci/e2e.sh`
		.env({
			...process.env,
			DOCKER_CONTEXT: CONTEXTO,
			AGENTS_CI_ID: `agents-release-${corto}`,
			AGENTS_CI_SHA: sha,
			AGENTS_CI_APP_IMAGE: `${REGISTRY}/agents-app:${corto}`,
			AGENTS_CI_SANDBOX_IMAGE: `${REGISTRY}/agents-sandbox:${corto}`,
			AGENTS_CI_BRIDGE: BRIDGE_PRUEBAS,
			AGENTS_CI_DB_TESTS: '1',
		})
		.nothrow();
	if (r.exitCode !== 0) falla(`Las pruebas en ${CONTEXTO} fallaron: no se firma ni se despliega ${corto}`);
}

/**
 * Firma en Komodo: el stack de un solo uso agents-firma corre cosign con la llave de las variables de Komodo
 * ([[COSIGN_*]]) y termina. Después se destruye, se vacía su entorno y se borra su .env del disco de reko-5.
 */
async function firmar(refs: string[], sha: string) {
	paso('Firmando en Komodo (stack agents-firma)');
	const usuario = (await enReko('echo "$(id -u):$(id -g) $HOME"')).stdout.toString().trim();
	const [uidgid, home] = usuario.split(' ');
	if (!uidgid || !home) falla('No pude leer el usuario de reko-5');
	const compose = `# Stack de un solo uso: lo arma \`just release\` en cada release (scripts/release/release.ts) y lo destruye al terminar.
name: ${STACK_FIRMA}
services:
  firma:
    image: ${COSIGN}
    restart: 'no'
    user: '${uidgid}'
    entrypoint: ['/busybox/sh', '-ec']
    command:
      - |
        COSIGN_PRIVATE_KEY="$$(printf '%s' "$$COSIGN_PRIVATE_KEY_B64" | base64 -d)"
        export COSIGN_PRIVATE_KEY
        unset COSIGN_PRIVATE_KEY_B64
${refs.map((r) => `        cosign sign --key env://COSIGN_PRIVATE_KEY ${FIRMAR} -a git_sha=${sha} -y ${r}`).join('\n')}
        echo FIRMA_OK
    environment:
      COSIGN_PRIVATE_KEY_B64: \${COSIGN_PRIVATE_KEY_B64:?}
      COSIGN_PASSWORD: \${COSIGN_PASSWORD:?}
      DOCKER_CONFIG: /docker
    volumes:
      - ${home}/.docker/config.json:/docker/config.json:ro
`;
	try {
		await komodo('write', 'UpdateStack', {
			id: STACK_FIRMA,
			config: {
				file_contents: compose,
				environment: 'COSIGN_PRIVATE_KEY_B64=[[COSIGN_PRIVATE_KEY_B64]]\nCOSIGN_PASSWORD=[[COSIGN_PASSWORD]]',
			},
		});
		await ejecutar('DeployStack', { stack: STACK_FIRMA });
		const contenedor = `${STACK_FIRMA}-firma-1`;
		let estado = '';
		for (let i = 0; i < 120 && !estado.startsWith('exited'); i++) {
			await Bun.sleep(1000);
			estado = (
				await $`docker --context ${CONTEXTO} inspect ${contenedor} --format '{{.State.Status}} {{.State.ExitCode}}'`
					.quiet()
					.nothrow()
			).stdout
				.toString()
				.trim();
		}
		const logs = (await $`docker --context ${CONTEXTO} logs ${contenedor}`.quiet().nothrow()).text();
		console.log(tapar(logs.trim().split('\n').slice(-12).join('\n')));
		if (estado !== 'exited 0' || !logs.includes('FIRMA_OK'))
			falla(`La firma no terminó bien (${estado || 'sin estado'})`);
	} finally {
		// Ni el contenedor (su entorno trae la llave) ni el .env del stack se quedan.
		await ejecutar('DestroyStack', { stack: STACK_FIRMA }).catch(() => {});
		await komodo('write', 'UpdateStack', {
			id: STACK_FIRMA,
			config: { environment: '', file_contents: 'services: {}\n' },
		});
		await $`docker --context ${CONTEXTO} exec komodo-periphery-1 rm -f /etc/komodo/stacks/${STACK_FIRMA}/.env`
			.quiet()
			.nothrow();
	}
}

/** Verifica en reko-5 contra release/cosign.pub: la llave esperada, el digest y el commit (anotación git_sha). */
async function verificar(ref: string, sha: string) {
	const r =
		await $`ssh ${CONTEXTO} ${`docker run --rm -i --user "$(id -u):$(id -g)" -e DOCKER_CONFIG=/docker -v "$HOME/.docker/config.json":/docker/config.json:ro --entrypoint /busybox/sh ${COSIGN} -ec 'cat > /tmp/cosign.pub && cosign verify --key /tmp/cosign.pub ${VERIFICAR} -a git_sha=${sha} ${ref} >/dev/null'`} < ${'release/cosign.pub'}`.nothrow();
	if (r.exitCode !== 0) falla(`La firma de ${ref} no verifica (llave, digest o commit ${sha.slice(0, 12)})`);
	console.log(`✓ firma verificada: ${ref}`);
}

/** :beta apunta al digest ya verificado (nunca a algo sin firma). */
async function promover(nombre: string, digest: string) {
	// --prefer-index=false: una copia exacta. Con un solo manifest de origen (se compila sin provenance), buildx si no
	// lo envuelve en un index nuevo, con otro digest y sin firma.
	const r = await enReko(
		`docker buildx imagetools create --prefer-index=false -t ${REGISTRY}/${nombre}:beta ${REGISTRY}/${nombre}@${digest}`,
	);
	if (r.exitCode !== 0) falla(`No pude mover ${nombre}:beta`);
	if ((await digestEnRegistry(`${REGISTRY}/${nombre}:beta`)) !== digest) falla(`${nombre}:beta no quedó en ${digest}`);
	console.log(`✓ ${nombre}:beta → ${digest.slice(0, 19)}…`);
}

// ------------------------------------------------------------------ despliegue

async function desplegar(sha: string) {
	const corto = sha.slice(0, 12);
	paso(`Komodo: el compose de ${corto} al stack ${STACK} y Deploy`);
	const compose = (await $`git show ${`${sha}:deploy/agents.compose.yaml`}`.quiet()).stdout.toString();
	const actual = ((await komodo('read', 'GetStack', { stack: STACK })).config as { file_contents?: string })
		?.file_contents;
	if (actual !== undefined && actual !== compose) {
		// Lo que cambia en producción, a la vista antes de aplicarlo (el compose no trae secretos: van en su Environment).
		const dir = join(tmpdir(), `agents-compose-${corto}`);
		await $`mkdir -p ${dir}`.quiet();
		await Bun.write(join(dir, 'komodo.yaml'), actual);
		await Bun.write(join(dir, 'release.yaml'), compose);
		console.log((await $`diff -u ${join(dir, 'komodo.yaml')} ${join(dir, 'release.yaml')}`.quiet().nothrow()).text());
		rmSync(dir, { recursive: true, force: true });
	} else if (actual === compose) console.log('(el compose del stack ya es el de este commit)');
	await komodo('write', 'UpdateStack', { id: STACK, config: { file_contents: compose } });
	await ejecutar('DeployStack', { stack: STACK });

	paso(`Esperando a que ${URL_PROD}/healthz diga ${corto}`);
	for (let i = 0; i < 100; i++) {
		const s = (await fetch(`${URL_PROD}/healthz`, { signal: AbortSignal.timeout(5000) })
			.then((r) => r.json())
			.catch(() => null)) as { ready?: boolean; sha?: string } | null;
		if (s?.ready && s.sha === sha) {
			console.log(`✓ ${URL_PROD} corre ${corto}`);
			return;
		}
		await Bun.sleep(3000);
	}
	falla(`${URL_PROD}/healthz no llegó a ${corto} en 5 minutos; revisa los logs del stack en Komodo`);
}

// ------------------------------------------------------------------ modos

async function revisarRama(): Promise<string> {
	paso('Revisando la rama');
	await $`git fetch -q origin ${RAMA}`;
	const rama = (await $`git rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
	if (rama !== RAMA) falla(`El release sale de ${RAMA}; estás en ${rama}`);
	// Puede ir adelante del remoto (el release sube), nunca atrás ni divergente.
	if ((await $`git merge-base --is-ancestor origin/${RAMA} HEAD`.nothrow()).exitCode !== 0)
		falla(`origin/${RAMA} tiene commits que no están aquí: tráelos primero`);
	// Las pruebas corren scripts/ci/e2e.sh de este checkout: tiene que ser el commit, sin cambios encima.
	if ((await $`git status --porcelain`.quiet()).stdout.toString().trim())
		falla('Hay cambios sin commit: commitea o guárdalos antes del release');
	return (await $`git rev-parse HEAD`.quiet()).stdout.toString().trim();
}

/** El push es un paso del release (después de las pruebas): el remoto queda igual que lo que corre en producción. */
async function subir(sha: string) {
	const remoto = (await $`git rev-parse origin/${RAMA}`.quiet()).stdout.toString().trim();
	if (remoto === sha) return;
	paso(`Subiendo ${RAMA} (${sha.slice(0, 12)})`);
	if ((await $`git push origin ${`${sha}:refs/heads/${RAMA}`}`.nothrow()).exitCode !== 0)
		falla(`No pude subir ${RAMA}`);
}

const SEMVER = /^v(\d+)\.(\d+)\.(\d+)-beta$/;

/**
 * La versión de este release: la que ya tenga el commit (un reintento), o la siguiente beta después del último tag
 * (v0.0.8-beta → 0.0.9-beta). El tag se crea al final, ya desplegado; hasta entonces el número se puede repetir.
 */
async function siguienteVersion(sha: string): Promise<string> {
	if ((await $`git fetch -q --tags origin`.nothrow()).exitCode !== 0) falla('No pude traer los tags de origin');
	const propias = (await $`git tag --points-at ${sha}`.quiet()).stdout
		.toString()
		.split('\n')
		.filter((t) => SEMVER.test(t));
	if (propias.length > 1) falla(`El commit ya tiene varias versiones (${propias.join(', ')}): revísalo a mano`);
	if (propias.length === 1) return propias[0]!.slice(1);
	const numeros = (await $`git tag --list ${'v*'}`.quiet()).stdout
		.toString()
		.split('\n')
		.map((t) => SEMVER.exec(t))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
		.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
	const ultima = numeros.at(-1);
	if (!ultima) return falla('No hay ningún tag vX.Y.Z-beta del cual seguir');
	return `${ultima[0]}.${ultima[1]}.${ultima[2] + 1}-beta`;
}

/** Ya desplegada: el tag anotado v<versión> en el commit, en origin. */
async function etiquetar(sha: string, version: string) {
	const tag = `v${version}`;
	paso(`Tag ${tag}`);
	const existente = (await $`git rev-parse -q --verify ${`refs/tags/${tag}^{commit}`}`.quiet().nothrow()).stdout
		.toString()
		.trim();
	if (existente && existente !== sha)
		falla(`${tag} ya existe en otro commit (${existente.slice(0, 12)}): revísalo a mano`);
	if (!existente) await $`git tag -a ${tag} ${sha} -m ${tag}`;
	if ((await $`git push origin ${`refs/tags/${tag}`}`.nothrow()).exitCode !== 0)
		falla(`Desplegado, pero no pude subir ${tag}: \`git push origin ${tag}\``);
	console.log(`✓ ${tag} → ${sha.slice(0, 12)}`);
}

async function publicar() {
	const sha = await revisarRama();
	const version = await siguienteVersion(sha);
	console.log(`Versión: v${version} (${sha.slice(0, 12)})`);
	acceso = await credenciales();
	await revisarKomodo();
	paso('Revisiones rápidas en esta Mac (secretos en el historial, formato, lint, tipos y pruebas sin base)');
	for (const args of [['sanitize', 'history'], ['format', 'check'], ['lint'], ['check']])
		if ((await $`just ${args}`.nothrow()).exitCode !== 0) falla(`just ${args.join(' ')} falló`);
	const digests = await compilar(sha, version);
	await probar(sha);
	await subir(sha);
	const refs = IMAGENES.map((i) => `${REGISTRY}/${i.nombre}@${digests[i.nombre]}`);
	await firmar(refs, sha);
	paso('Verificando y moviendo :beta');
	for (const ref of refs) await verificar(ref, sha);
	for (const i of IMAGENES) await promover(i.nombre, digests[i.nombre]);
	await desplegar(sha);
	await etiquetar(sha, version);
}

/** Una versión ya publicada, por su sha de 12 o su tag (v0.0.9-beta). Las imágenes se encuentran por el sha. */
async function volverA(referencia: string) {
	if (SEMVER.test(referencia)) await $`git fetch -q --tags origin`.nothrow();
	const sha = (await $`git rev-parse --verify ${`${referencia}^{commit}`}`.quiet().nothrow()).stdout.toString().trim();
	if (!/^[0-9a-f]{40}$/.test(sha)) falla(`No encuentro ${referencia} en este repo`);
	const prefijo = sha.slice(0, 12);
	acceso = await credenciales();
	await revisarKomodo();
	paso(`Volviendo a ${referencia} (${prefijo}): verificando y moviendo :beta`);
	const digests = {} as Record<Nombre, string>;
	for (const i of IMAGENES) {
		digests[i.nombre] = await digestEnRegistry(`${REGISTRY}/${i.nombre}:${prefijo}`);
		await verificar(`${REGISTRY}/${i.nombre}@${digests[i.nombre]}`, sha);
	}
	for (const i of IMAGENES) await promover(i.nombre, digests[i.nombre]);
	await desplegar(sha);
}

// Un release a la vez (el bridge de las pruebas y el stack de firma son únicos).
const candado = join((await $`git rev-parse --git-common-dir`.quiet()).stdout.toString().trim(), 'agents-release.lock');
try {
	closeSync(openSync(candado, 'wx', 0o600));
} catch {
	falla(`Ya hay un release corriendo (${candado}); si no es así, bórralo`);
}
// También cuando falla() sale con process.exit (que no pasa por un finally).
process.on('exit', () => rmSync(candado, { force: true }));
const [modo] = process.argv.slice(2);
if (!modo) await publicar();
else if (/^[0-9a-f]{12}$/.test(modo) || SEMVER.test(modo)) await volverA(modo);
else falla(`Uso: just release [<sha de 12> | vX.Y.Z-beta]; «${modo}» no es ninguno`);

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { defaultHarness, harnessInstructions, validateHarness } from '../../sandbox/harness';
import { withHarnessPrompt } from './harnesses';
import { systemPrompt } from './prompt';

const agent = { name: 'Analista', role: 'Procesa los archivos del usuario.' };

test('bash permits reusable scripts and local dependencies without changing the approved harness', () => {
	const h = defaultHarness(),
		before = JSON.stringify(h);
	const prompt = withHarnessPrompt(systemPrompt(agent, []), h);
	for (const text of [
		'crear, ejecutar y conservar scripts propios',
		'dependencias locales con uv o bun (la computadora corre con Bun; no hay Node.js ni npm) dentro de ~/work',
		'sin una aprobación adicional por cada script o paquete',
		'~/work/tools/',
		'versiones',
		'instrucciones de ejecución',
		'Verifica el resultado',
	])
		expect(prompt).toContain(text);
	expect(prompt).toContain('no instales globalmente');
	expect(prompt).toContain('~/state/tools (gestionado por la plataforma)');
	expect(prompt).toContain('sólo se cargan los recursos aprobados explícitamente');
	expect(prompt).toContain('No registres herramientas ni servidores MCP adicionales');
	expect(JSON.stringify(h)).toBe(before);
});

test('a read-only harness does not promise shell execution, installations, browser or login', () => {
	const h = validateHarness({
		...defaultHarness(),
		tools: ['read', 'request_help'],
		restrictions: { workspaceFilesOnly: true, readOnlyFiles: true, guidelines: [] },
	});
	const prompt = harnessInstructions(h);
	expect(prompt).toContain('Herramientas disponibles: read, request_help.');
	expect(prompt).toContain('No hay shell disponible: no ejecutes scripts ni instales dependencias por otros medios.');
	expect(prompt).toContain('No hay navegador disponible');
	expect(prompt).toContain('Sólo lectura');
	expect(prompt).not.toContain('puedes crear, ejecutar');
	expect(prompt).not.toContain('Usa browser');
	expect(prompt).not.toContain('Usa login');
});

test('navigation instructions follow the available tools, including the documented bash equivalence', () => {
	const base = defaultHarness();
	const browserOnly = validateHarness({ ...base, tools: ['browser', 'request_help'] });
	expect(harnessInstructions(browserOnly)).toContain('Usa browser para navegar.');
	expect(harnessInstructions(browserOnly)).toContain('No hay shell disponible');
	const shellOnly = validateHarness({ ...base, tools: ['bash', 'request_help'] });
	expect(harnessInstructions(shellOnly)).toContain(
		'Para navegar usa agent-browser mediante bash, en la sesión visible.',
	);
	expect(harnessInstructions(shellOnly)).not.toContain('Usa browser');
	expect(harnessInstructions(base)).toContain('Usa login sólo para accesos ya concedidos.');
});

test('global policy distinguishes visible browsing from authorized APIs and dependency downloads', () => {
	const prompt = systemPrompt(agent, []);
	expect(prompt).toContain('La navegación e interacción con páginas web se hacen en el navegador visible');
	expect(prompt).toContain('Para APIs de servicios autorizados puedes usar los MCP, CLI o scripts');
	expect(prompt).toContain('puedes descargar dependencias');
	expect(prompt).toContain('Eso no autoriza nuevos accesos');
	expect(prompt).toContain('evadir un bloqueo');
	expect(prompt).toContain('extraer sesiones/contraseñas del navegador');
	expect(prompt).toContain('no uses sudo');
	expect(prompt).toContain('no pidas permiso para cada detalle de implementación');
	expect(prompt).toContain('no supongas que puedes ejecutar comandos');
	// WhatsApp is part of the product (#18): a message from there gets a short, plain answer.
	expect(prompt).toContain('Si un mensaje llegó por WhatsApp, responde en texto simple');
	// Autonomy: it decides what its contract does not reserve, and asks only in three cases.
	expect(prompt).toContain('**Decide tú** todo lo que tu contrato no le reserva expresamente a tu dueño');
	expect(prompt).toContain('**Pide ayuda sólo en tres casos:**');
	expect(prompt).toContain('Nunca pidas que te confirmen lo que ya te dijeron o aprobaron');
	// Its messages: short, without its own bookkeeping.
	expect(prompt).toContain('**Corto, directo y concreto**');
	expect(prompt).toContain('No le cuentes tu bitácora');
	expect(prompt).toContain('de una a tres líneas');
	expect(prompt).not.toContain('como máximo un reintento');
	expect(prompt).not.toContain('Nunca uses `curl`, `wget`, scripts ni APIs');
});

test('autonomy retains purchase authorization, human takeover and secret-handling rules', () => {
	const prompt = systemPrompt(agent, ['tienda']);
	expect(prompt).toContain('Nunca pagas, reservas, confirmas un pedido ni haces una compra');
	expect(prompt).toContain('Nunca creas cuentas');
	expect(prompt).toContain('no los muestres, copies ni resumas');
	expect(prompt).toContain('no las imprimas, copies a archivos ni incluyas en entregables');
	expect(prompt).toContain('tomar el control de tu navegador');
	expect(prompt).toContain('`agents-login <nombre>`');
	const authorized = systemPrompt(
		{ ...agent, role: '## Compras autorizadas\nSólo tienda.example hasta $100, confirmando siempre.' },
		[],
	);
	expect(authorized).not.toContain('Nunca pagas, reservas');
	expect(authorized).toContain('sólo si la tarea lo pide y cabe en tu sección');
	expect(authorized).toContain('Si el sitio pide CVV');
});

test('the designer narrows what the owner needs and leaves the rest open', () => {
	const skill = readFileSync(new URL('../skills/grill-me.md', import.meta.url), 'utf8');
	expect(skill.length).toBeLessThan(8000); // little to keep and to read
	expect(skill).toContain('Sirve para acotar lo que el dueño necesita, no para ampliarlo.');
	expect(skill).toContain('No pidas confirmación ni hagas rondas de cortesía.');
	expect(skill).toContain('Cambia lo mínimo');
	// The two sections the platform acts on, only when asked.
	expect(skill).toContain('`## Compras autorizadas`');
	expect(skill).toContain('`## Avisos por WhatsApp`');
	expect(skill).toContain('Nunca pidas un secreto por chat');
});

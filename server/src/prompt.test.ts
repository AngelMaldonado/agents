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
		'dependencias locales con uv o npm dentro de ~/work',
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

test('the designer distinguishes provisioning, harness approval and implementation details', () => {
	const skill = readFileSync(new URL('../skills/grill-me.md', import.meta.url), 'utf8');
	expect(skill).toContain('Creación y Automejora configuran el contrato y el harness de pi');
	expect(skill).toContain('Sin bash no prometas ejecución ni instalaciones autónomas');
	expect(skill).toContain('no requieren pasar por Automejora ni pedir permiso para cada script o paquete');
	expect(skill).toContain('no son una lista exhaustiva de las librerías que un script puede usar');
	expect(skill).toContain('no de los scripts y dependencias locales que puede usar bash');
	expect(skill).toContain('ni garantiza que una integración o una dependencia externa funcione');
	expect(skill).not.toContain('No prometas código generado de plugins, instalaciones externas');
});

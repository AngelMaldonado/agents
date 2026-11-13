// Personalidad (Angel 12-nov-2026): three dials its owner sets in Avanzado, from 1 to 5 (how it sounds is its
// style, shared/souls.ts, since 13-nov). Each one off its middle
// (3) adds a line to a «Tu personalidad» section of its prompt; at 3, the platform's own rules stand. They
// shape how it writes and decides; they never lift a platform rule nor what its contract reserves to its owner.
export const DIALS = [
	{
		key: 'autonomia',
		name: 'Autonomía',
		low: 'Consulta',
		high: 'Decide',
		lines: {
			1: 'Antes de cualquier efecto externo (enviar, comprar, confirmar), consulta con tu dueño aunque tu contrato lo permita.',
			2: 'Si una decisión afecta a terceros y tienes dudas, consulta con tu dueño.',
			4: 'Si tu contrato no lo dice, decide tú lo razonable y avisa después.',
			5: 'Decide tú todo lo que no esté reservado a tu dueño, aunque te falte información; pregunta sólo lo irreversible.',
		},
	},
	{
		key: 'proactividad',
		name: 'Proactividad',
		low: 'Espera',
		high: 'Avisa',
		lines: {
			1: 'Avisa sólo cuando te lo pidan o haya un bloqueo.',
			2: 'Avisa sólo los cambios importantes.',
			4: 'Avisa los avances relevantes sin que te lo pidan.',
			5: 'Mantén informados a todos: avisa cada avance y anticipa lo que viene.',
		},
	},
	{
		key: 'rigor',
		name: 'Rigor',
		low: 'Rápido',
		high: 'Meticuloso',
		lines: {
			1: 'Prioriza la velocidad: una aproximación razonable basta.',
			2: 'Verifica sólo lo crítico.',
			4: 'Verifica tus resultados antes de entregarlos.',
			5: 'Sé meticuloso: comprueba dos veces cada dato, suma y fuente.',
		},
	},
] as const;
export type DialKey = (typeof DIALS)[number]['key'];
export type Personality = Partial<Record<DialKey, number>>;

/** What its owner sent, kept only as whole numbers from 1 to 5 of known dials. */
export function cleanPersonality(input: unknown): Personality {
	const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
	const out: Personality = {};
	for (const d of DIALS) {
		const v = Number(raw[d.key]);
		if (Number.isInteger(v) && v >= 1 && v <= 5) out[d.key] = v;
	}
	return out;
}

/** Its section of the prompt, or '' when every dial is at its middle. */
export function personalitySection(p: Personality | null | undefined) {
	const lines = DIALS.flatMap((d) => {
		const v = p?.[d.key];
		const line = v && v !== 3 ? (d.lines as Record<number, string>)[v] : undefined;
		return line ? [`- ${line}`] : [];
	});
	return lines.length ? `## Tu personalidad (la ajustó tu dueño)\n\n${lines.join('\n')}` : '';
}

// Backward-compatible, bounded UI metadata in request_help.reason. Never executable authority.
import { validateQuestions, type Question } from './interview';
export type Help = { reason: string; questions: Question[]; structured: boolean };
const fallback = 'El agente necesita tu ayuda. Escribe cómo quieres que continúe.';
export function decodeHelp(value: unknown): Help {
	const raw = String(value ?? '').slice(0, 2000);
	const candidate = raw
		.trim()
		.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')
		.trim();
	let reason = /^[\s]*[[{]/.test(candidate) || /^\s*```/.test(raw) ? fallback : raw;
	try {
		const v = JSON.parse(candidate);
		if (typeof v?.reason === 'string' && v.reason.trim() && !/^[\s]*[[{`]/.test(v.reason))
			reason = v.reason.trim().slice(0, 2000);
		if (
			v?.version === 1 &&
			Object.keys(v).every((k) => ['version', 'reason', 'questions'].includes(k)) &&
			typeof v.reason === 'string' &&
			v.reason.trim() &&
			v.reason.length <= 2000 &&
			Array.isArray(v.questions)
		) {
			// Only fresh model metadata: missing presentation fields are harmless. Never repair human answers.
			const questions = validateQuestions(
				v.questions.map((q: any) =>
					q && typeof q === 'object'
						? {
								...q,
								description: q.description === undefined ? '' : q.description,
								recommended: q.recommended === undefined ? null : q.recommended,
								options: Array.isArray(q.options)
									? q.options.map((o: any) =>
											o && typeof o === 'object'
												? { ...o, description: o.description === undefined ? '' : o.description }
												: o,
										)
									: q.options,
							}
						: q,
				),
			);
			if (questions.length) return { reason, questions, structured: true };
		}
	} catch {
		/* Render human text, never transport JSON or invented decisions. */
	}
	return { reason: reason || fallback, questions: [], structured: false };
}
export function helpData(data: any, preserveQuestions = false, answeredQuestions?: Question[]): Help {
	const decoded = decodeHelp(data?.reason);
	if (answeredQuestions)
		return {
			reason: data?.structured === true ? data.reason : decoded.reason,
			questions: answeredQuestions,
			structured: data?.structured === true || decoded.structured,
		};
	// A saved valid round or an answered legacy fallback keeps its exact original question IDs/options.
	if (data?.questions?.length && typeof data.reason === 'string' && (data.structured === true || preserveQuestions))
		return {
			reason: data.structured === true ? data.reason : decoded.reason,
			questions: data.questions,
			structured: data.structured === true,
		};
	return decoded;
}

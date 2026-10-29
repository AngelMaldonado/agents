// Pure validation: neither a model's answer nor a browser draft is trusted as configuration.
import { HARNESS_SCHEMA, TOOLS, validateHarness, type Harness } from '../../sandbox/harness';
export type Contract = { name: string; prompt: string };
import { QUESTIONS_SCHEMA, validateQuestions, type Question } from './interview';
export type DesignReply = { message: string; contract: Contract | null; harness: Harness | null; ready: boolean; questions: Question[] };
export const TOOL_CATALOG = TOOLS;
export const INIT_STEPS = [
 { id: 'contract', label: 'Guardar el contrato aprobado' },
 { id: 'computer', label: 'Obtener turno y arrancar la computadora' },
 { id: 'workspace', label: 'Preparar memoria y espacio de trabajo' },
 { id: 'tools', label: 'Comprobar las herramientas' },
 { id: 'browser', label: 'Abrir y comprobar Chrome' },
 { id: 'ready', label: 'Cerrar la comprobación y dejarlo listo' }
] as const;
export const REPLY_FORMAT = { type: 'json_schema', name: 'agent_contract', strict: true, schema: {
 type: 'object', additionalProperties: false, required: ['message', 'contract', 'harness', 'ready', 'questions'], properties: {
  questions: QUESTIONS_SCHEMA,
  harness: { anyOf: [{ type: 'null' }, HARNESS_SCHEMA] },
  message: { type: 'string' }, ready: { type: 'boolean' },
  contract: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['name', 'prompt'], properties: { name: { type: 'string' }, prompt: { type: 'string' } } }] }
 }
} };
export function validateContract(value: unknown): Contract {
 const c = value as Contract;
 if (!c || typeof c.name !== 'string' || !c.name.trim() || c.name.trim().length > 40) throw new Error('El contrato necesita un nombre de hasta 40 caracteres.');
 if (typeof c.prompt !== 'string' || !c.prompt.trim() || c.prompt.length > 16000) throw new Error('El contrato necesita un prompt de hasta 16000 caracteres.');
 return { name: c.name.trim(), prompt: c.prompt.trim() };
}
export function parseDesignReply(response: any): DesignReply {
 if (response?.status !== 'completed') throw new Error('La IA no terminó la respuesta. Reintenta o pide un contrato más breve.');
 const text = (Array.isArray(response.output) ? response.output : []).filter((o: any) => o.type === 'message' && o.role === 'assistant')
  .flatMap((o: any) => Array.isArray(o.content) ? o.content : []).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('');
 let r: any;
 try { r = JSON.parse(text); } catch { throw new Error('La IA no devolvió un contrato válido. Reintenta la respuesta.'); }
 if (!r || typeof r.message !== 'string' || !r.message.trim() || r.message.length > 16000 || typeof r.ready !== 'boolean') throw new Error('La respuesta de la IA no tiene el formato esperado.');
 const contract = r.contract === null ? null : validateContract(r.contract);
 if (r.ready && !contract) throw new Error('La IA no puede declarar listo un contrato vacío.');
 return { message: r.message.trim(), contract, harness: r.harness == null ? null : validateHarness(r.harness), ready: r.ready, questions: validateQuestions(r.questions ?? []) };
}

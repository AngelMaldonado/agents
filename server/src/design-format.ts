// Pure validation: neither a model's answer nor a browser draft is trusted as configuration.
import { HARNESS_SCHEMA, TOOLS, validateHarness, type Harness } from '../../sandbox/harness';
export type Contract = { name: string; prompt: string };
import { QUESTIONS_SCHEMA, validateQuestions, type Question } from './interview';
// A schedule wakes the agent with its message (cron, America/Mexico_City). null: keep what there is.
export type ScheduleProposal = { cron: string; message: string };
export type DesignReply = { message: string; contract: Contract | null; harness: Harness | null; schedules: ScheduleProposal[] | null; ready: boolean; questions: Question[] };
export const MAX_SCHEDULES = 10;
const SCHEDULES_SCHEMA = { anyOf: [{ type: 'null' }, { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cron', 'message'], properties: { cron: { type: 'string' }, message: { type: 'string' } } } }] };
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
function cronField(field: string, [lo, hi]: readonly [number, number]) {
 return field.split(',').every(part => {
  const m = part.match(/^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
  if (!m) return false;
  const from = m[1] ? lo : Number(m[2]), to = m[1] ? hi : m[3] !== undefined ? Number(m[3]) : from, step = m[4] !== undefined ? Number(m[4]) : 1;
  return from >= lo && to <= hi && from <= to && step >= 1;
 });
}
/** Five numeric cron fields, at most every 15 minutes, a message each, no duplicates. */
export function validateSchedules(value: unknown): ScheduleProposal[] | null {
 if (value === null || value === undefined) return null;
 if (!Array.isArray(value) || value.length > MAX_SCHEDULES) throw new Error(`Hasta ${MAX_SCHEDULES} horarios por agente.`);
 const seen = new Set<string>();
 return value.map(s => {
  const cron = String(s?.cron ?? '').trim().split(/\s+/).join(' '), message = String(s?.message ?? '').trim();
  const fields = cron.split(' ');
  if (fields.length !== 5 || !fields.every((f, i) => cronField(f, CRON_RANGES[i]))) throw new Error(`Horario inválido «${cron}»: usa cron de 5 campos numéricos (minuto hora día mes día-de-semana).`);
  const minute = fields[0].match(/^\*(?:\/(\d+))?$/);
  if (minute && Number(minute[1] ?? 1) < 15) throw new Error(`«${cron}» despierta al agente demasiado seguido: como máximo cada 15 minutos.`);
  if (!message || message.length > 2000) throw new Error('Cada horario necesita un mensaje de hasta 2000 caracteres.');
  const key = `${cron}\n${message}`;
  if (seen.has(key)) throw new Error(`Horario repetido: «${cron}».`);
  seen.add(key);
  return { cron, message };
 });
}
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
 type: 'object', additionalProperties: false, required: ['message', 'contract', 'harness', 'schedules', 'ready', 'questions'], properties: {
  questions: QUESTIONS_SCHEMA,
  harness: { anyOf: [{ type: 'null' }, HARNESS_SCHEMA] },
  schedules: SCHEDULES_SCHEMA,
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
 return { message: r.message.trim(), contract, harness: r.harness == null ? null : validateHarness(r.harness), schedules: validateSchedules(r.schedules ?? null), ready: r.ready, questions: validateQuestions(r.questions ?? []) };
}

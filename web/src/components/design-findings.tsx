// The designer's tool search in the chat (#26): each search is an assistant-ui tool call, what it found
// is a carousel of cards (Tool UI's ItemCarousel) the owner adds or skips, and anything secret is typed
// in a card that saves it straight to the owner's accesses: values never go through the model.
import { createContext, useContext, useState } from 'react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import { Check, KeyRound, LoaderCircle, Lock, Search, TriangleAlert } from 'lucide-react';
import type { DesignMessage, Finding, SecretRequest } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ItemCarousel } from './tool-ui/item-carousel';

export type FindingsActions = {
	messages: DesignMessage[];
	/** Waiting for a reply, approved or with an unsent message: the cards wait too. */
	blocked: boolean;
	decide: (
		message: number,
		finding: string,
		choice: 'added' | 'skipped',
		values?: Record<string, string>,
		domains?: string[],
	) => Promise<void>;
	saveSecret: (message: number, name: string, value: string, domains: string[]) => Promise<void>;
};
export const FindingsContext = createContext<FindingsActions | null>(null);

const registries: Record<string, string> = {
	buscar_mcp: 'el registro de MCP',
	buscar_cli: 'npm',
	buscar_skills: 'skills.sh',
};
const kinds = { mcp: 'Servidor MCP', cli: 'CLI (npm)', skill: 'Skill' };
const splitDomains = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);

/** One search the designer ran, as a finished tool call. */
export function SearchCall({ toolName, args, result }: ToolCallMessagePartProps) {
	const query = (args as { consulta?: string })?.consulta ?? '';
	const r = result as { results: number; error?: string } | undefined;
	return (
		<p className="designer-tool-call">
			{r?.error ? (
				<TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
			) : (
				<Search className="size-3.5 shrink-0" aria-hidden="true" />
			)}
			<span className="min-w-0">
				Buscó «{query}» en {registries[toolName] ?? toolName}
				<span className="text-muted-foreground">
					{' · '}
					{r?.error ? `no respondió (${r.error})` : `${r?.results ?? 0} resultado${r?.results === 1 ? '' : 's'}`}
				</span>
			</span>
		</p>
	);
}

/** What one reply found: cards to add or skip, plus the secrets it asked for. */
export function DesignFindings({ index }: { index: number }) {
	const ctx = useContext(FindingsContext);
	const message = ctx?.messages[index];
	if (!ctx || !message || message.role !== 'assistant') return null;
	return (
		<>
			{!!message.findings?.length && <FindingsCards index={index} findings={message.findings} ctx={ctx} />}
			{message.secrets?.map((s) => (
				<SecretCard key={s.name} index={index} request={s} ctx={ctx} />
			))}
		</>
	);
}

function FindingsCards({ index, findings, ctx }: { index: number; findings: Finding[]; ctx: FindingsActions }) {
	const [setup, setSetup] = useState<Finding | null>(null);
	const [busy, setBusy] = useState<string | null>(null),
		[error, setError] = useState('');
	const run = async (f: Finding, choice: 'added' | 'skipped', values?: Record<string, string>, domains?: string[]) => {
		setBusy(f.id);
		setError('');
		try {
			await ctx.decide(index, f.id, choice, values, domains);
			setSetup(null);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="designer-findings">
			<ItemCarousel
				id={`hallazgos-${index}`}
				title="Herramientas encontradas"
				description="Agrega las que sirvan: un MCP queda como acceso tuyo, una skill entra al harness y una CLI la incluye el diseñador."
				items={findings.map((f) => ({
					id: f.id,
					name: f.title,
					subtitle: [
						kinds[f.kind],
						f.version && `v${f.version}`,
						f.fields.some((x) => x.secret) && 'pide un secreto',
						f.mcp?.transport === 'http' && f.mcp.oauth && 'inicias sesión después (OAuth)',
						f.description,
					]
						.filter(Boolean)
						.join(' · '),
					actions:
						f.status === 'added'
							? [
									{
										id: 'done',
										label: 'Agregado',
										variant: 'secondary',
										disabled: true,
										icon: <Check aria-hidden="true" />,
									},
								]
							: f.status === 'skipped'
								? [{ id: 'done', label: 'Descartado', variant: 'ghost', disabled: true }]
								: [
										{
											id: 'add',
											label: busy === f.id ? 'Agregando…' : 'Agregar',
											variant: 'default',
											disabled: ctx.blocked || busy !== null,
										},
										{ id: 'skip', label: 'Descartar', variant: 'ghost', disabled: ctx.blocked || busy !== null },
									],
				}))}
				onItemAction={(id, action) => {
					const f = findings.find((x) => x.id === id)!;
					if (action === 'skip') void run(f, 'skipped');
					else if (action === 'add')
						// An MCP that needs values (a secret, or one the registry does not give) asks for them first.
						f.kind === 'mcp' && f.fields.some((x) => x.secret || !x.value) ? setSetup(f) : void run(f, 'added');
				}}
			/>
			{error && (
				<p role="alert" className="error mt-2 text-xs">
					{error}
				</p>
			)}
			{setup && (
				<McpSetup
					finding={setup}
					busy={busy === setup.id}
					onCancel={() => setSetup(null)}
					onSave={(values, domains) => void run(setup, 'added', values, domains)}
				/>
			)}
		</div>
	);
}

/** The values an MCP server needs before it becomes the owner's access; secrets go to the vault. */
function McpSetup({
	finding,
	busy,
	onCancel,
	onSave,
}: {
	finding: Finding;
	busy: boolean;
	onCancel: () => void;
	onSave: (values: Record<string, string>, domains: string[]) => void;
}) {
	const fields = finding.fields.filter((x) => x.secret || !x.value);
	const [values, setValues] = useState<Record<string, string>>({});
	const local = finding.mcp?.transport === 'stdio' && finding.fields.some((x) => x.secret);
	const [domains, setDomains] = useState('');
	const ready = fields.every((x) => values[x.name]?.trim()) && (!local || splitDomains(domains).length > 0);
	return (
		<form
			className="designer-secret-card"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready) onSave(values, splitDomains(domains));
			}}
		>
			<p className="flex items-center gap-2 text-xs font-medium">
				<Lock className="size-4 text-primary" aria-hidden="true" />
				Configurar {finding.title}
			</p>
			<p className="text-2xs text-muted-foreground">
				Se guarda como tu servidor MCP en Configuración → Accesos y se concede a este agente al inicializarlo. Lo
				secreto se cifra y no pasa por el diseñador.
			</p>
			{fields.map((x) => (
				<label key={x.name} className="grid gap-1 text-xs">
					<span className="font-medium">
						{x.name}
						{x.template && <span className="font-normal text-muted-foreground"> · se envía como «{x.template}»</span>}
					</span>
					<Input
						type={x.secret ? 'password' : 'text'}
						autoComplete="off"
						value={values[x.name] ?? ''}
						onChange={(e) => setValues({ ...values, [x.name]: e.target.value })}
						placeholder={x.description || x.name}
					/>
				</label>
			))}
			{local && (
				<label className="grid gap-1 text-xs">
					<span className="font-medium">Dominios a los que llama</span>
					<Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="api.ejemplo.com" />
					<span className="text-2xs text-muted-foreground">
						Corre en la computadora del agente: el secreto sólo se entrega en peticiones a estos dominios.
					</span>
				</label>
			)}
			<div className="flex justify-end gap-2">
				<Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
					Cancelar
				</Button>
				<Button size="sm" disabled={!ready || busy}>
					{busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
					Guardar y agregar
				</Button>
			</div>
		</form>
	);
}

/** A credential the designer asked for: saved as the owner's API key, never typed in the chat. */
function SecretCard({ index, request, ctx }: { index: number; request: SecretRequest; ctx: FindingsActions }) {
	const [value, setValue] = useState('');
	const [domains, setDomains] = useState(request.domains.join(', '));
	const [busy, setBusy] = useState(false),
		[error, setError] = useState('');
	if (request.saved)
		return (
			<p className="designer-tool-call text-success">
				<Check className="size-3.5 shrink-0" aria-hidden="true" />
				<code>{request.name}</code> guardada en tus accesos
			</p>
		);
	return (
		<form
			className="designer-secret-card"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				setError('');
				try {
					await ctx.saveSecret(index, request.name, value, splitDomains(domains));
					setValue('');
				} catch (err) {
					setError((err as Error).message);
				} finally {
					setBusy(false);
				}
			}}
		>
			<p className="flex items-center gap-2 text-xs font-medium">
				<Lock className="size-4 text-primary" aria-hidden="true" />
				<code>{request.name}</code>
			</p>
			{request.description && <p className="text-xs text-muted-foreground">{request.description}</p>}
			<Input
				type="password"
				autoComplete="off"
				aria-label={`Valor de ${request.name}`}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder="Pega el valor aquí; no lo escribas en el chat"
			/>
			<label className="grid gap-1 text-xs">
				<span className="font-medium">Dominios a los que se envía</span>
				<Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="api.ejemplo.com" />
			</label>
			<p className="text-2xs text-muted-foreground">
				Se guarda cifrada como tu API key y se concede a este agente al inicializarlo. El diseñador sólo sabe que
				existe.
			</p>
			{error && (
				<p role="alert" className="error text-xs">
					{error}
				</p>
			)}
			<div className="flex justify-end">
				<Button size="sm" disabled={busy || ctx.blocked || !value.trim() || !splitDomains(domains).length}>
					{busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
					Guardar en tus accesos
				</Button>
			</div>
		</form>
	);
}

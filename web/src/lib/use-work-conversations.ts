import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, isLive, type Agent, type Conversation, type ConversationPage, type Task, type TaskEvent } from '@/api';
import { onEvent, onTask } from '@/live';
type Page = ConversationPage & { loading: boolean; error: string };
const mergeEvents = (a: TaskEvent[], b: TaskEvent[]) =>
	[...new Map([...a, ...b].map((e) => [e.id, e])).values()].sort((x, y) => x.id - y.id);
export function useWorkConversations(
	agent: Agent & { mine: boolean },
	viewerId: number,
	conversations: Conversation[],
	setConversations: Dispatch<SetStateAction<Conversation[]>>,
	loaded: boolean,
	enabled: boolean,
	// The selected conversation's transcript: loaded and polled only while it is on screen (the chat
	// view). The hub needs the list, not a transcript.
	follow = enabled,
) {
	const storageKey = `agents.conversation.${viewerId}.${agent.id}`;
	const [selected, setSelected] = useState<number | null>(() => {
		try {
			const n = Number(localStorage.getItem(storageKey));
			return n > 0 ? n : null;
		} catch {
			return null;
		}
	});
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const [pages, setPages] = useState<Record<number, Page>>({}),
		pagesRef = useRef(pages);
	pagesRef.current = pages;
	const [agentTask, setAgentTask] = useState<Task | null>(agent.task);
	const listTicket = useRef(0);
	const tickets = useRef(new Map<number, number>()),
		revisions = useRef(new Map<number, number>()),
		selectionTicket = useRef(0),
		createKey = useRef<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);
	useEffect(() => {
		if (agent.task) setAgentTask((t) => (!t || agent.task!.id >= t.id ? agent.task : t));
	}, [agent.task]);
	const choose = useCallback(
		(id: number | null) => {
			selectedRef.current = id;
			setSelected(id);
			try {
				if (id === null) localStorage.removeItem(storageKey);
				else localStorage.setItem(storageKey, String(id));
			} catch {
				/* storage is optional */
			}
		},
		[storageKey],
	);
	useEffect(() => {
		if (!loaded) return;
		const allowed = conversations.filter((c) => !agent.mine || !c.archived_at);
		if (selectedRef.current !== null && allowed.some((c) => c.id === selectedRef.current)) return;
		choose((allowed.find((c) => c.is_default) ?? allowed[0])?.id ?? null);
	}, [loaded, conversations, choose, agent.mine]);
	const load = useCallback(
		async (id: number, older = false) => {
			const ticket = (tickets.current.get(id) ?? 0) + 1;
			tickets.current.set(id, ticket);
			const revision = revisions.current.get(id) ?? 0,
				old = pagesRef.current[id];
			setPages((p) => ({ ...p, [id]: { ...p[id], loading: true, error: '' } as Page }));
			try {
				const page: ConversationPage = await api(
					`/agents/${agent.id}/conversations/${id}${older && old?.before ? `?before=${old.before}` : ''}`,
				);
				if (!alive.current || tickets.current.get(id) !== ticket) return;
				if (page.conversation.id !== id || page.conversation.agent_id !== agent.id)
					throw new Error('La conversación recibida no coincide.');
				setPages((p) => {
					const previous = p[id],
						previousRecords = previous?.records ?? [];
					const map = new Map(previousRecords.map((r) => [r.task.id, r]));
					for (const r of page.records) {
						const saved = map.get(r.task.id),
							changed = (revisions.current.get(id) ?? 0) !== revision;
						map.set(
							r.task.id,
							saved
								? {
										...r,
										events: mergeEvents(saved.events, r.events),
										task: changed ? saved.task : !isLive(saved.task) && isLive(r.task) ? saved.task : r.task,
									}
								: r,
						);
					}
					const records = [...map.values()].sort((a, b) => a.task.id - b.task.id);
					const inputs = [
						...new Map([...(previous?.inputs ?? []), ...page.inputs].map((m) => [m.id, m])).values(),
					].sort((a, b) => a.id - b.id);
					return {
						...p,
						[id]: {
							...page,
							records,
							inputs,
							hasEarlier: older
								? page.hasEarlier
								: previous?.before && previous.before < (page.before ?? Infinity)
									? previous.hasEarlier
									: page.hasEarlier,
							before: records[0]?.task.id ?? null,
							loading: false,
							error: '',
						},
					};
				});
			} catch (e) {
				if (alive.current && tickets.current.get(id) === ticket)
					setPages((p) => ({ ...p, [id]: { ...p[id], loading: false, error: (e as Error).message } as Page }));
			}
		},
		[agent.id],
	);
	useEffect(() => {
		if (selected !== null && follow) void load(selected);
	}, [selected, follow, load]);
	useEffect(() => {
		const offT = onTask((t) => {
			if (t.agent_id !== agent.id) return;
			setAgentTask((old) => (!old || t.id >= old.id ? t : old));
			revisions.current.set(t.conversation_id, (revisions.current.get(t.conversation_id) ?? 0) + 1);
			setPages((p) => {
				const page = p[t.conversation_id];
				if (!page?.records) return p;
				const exists = page.records.some((r) => r.task.id === t.id);
				return {
					...p,
					[t.conversation_id]: {
						...page,
						records: exists
							? page.records.map((r) => (r.task.id === t.id ? { ...r, task: t } : r))
							: [...page.records, { task: t, events: [], artifacts: [] }],
					},
				};
			});
			if (follow && selectedRef.current === t.conversation_id) void load(t.conversation_id);
		});
		const offE = onEvent((runId, event) => {
			setPages((p) => {
				const id = Object.keys(p)
					.map(Number)
					.find((id) => p[id].records?.some((r) => r.task.id === runId));
				if (id === undefined) return p;
				revisions.current.set(id, (revisions.current.get(id) ?? 0) + 1);
				return {
					...p,
					[id]: {
						...p[id],
						records: p[id].records.map((r) =>
							r.task.id === runId ? { ...r, events: mergeEvents(r.events, [event]) } : r,
						),
					},
				};
			});
		});
		return () => {
			offT();
			offE();
		};
	}, [agent.id, follow, load]);
	// Poll durable inbox state, not GPT. No implicit model retry.
	useEffect(() => {
		if (!follow || selected === null) return;
		const timer = setInterval(() => {
			if (!pagesRef.current[selected]?.loading) void load(selected);
		}, 2500);
		return () => clearInterval(timer);
	}, [follow, selected, load]);
	const loadList = useCallback(async () => {
		const ticket = ++listTicket.current,
			data = await api(`/agents/${agent.id}/conversations`);
		if (alive.current && ticket === listTicket.current) setConversations(data.conversations);
		return data;
	}, [agent.id, setConversations]);
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(() => {
			void loadList().catch(() => {});
		}, 5000);
		return () => clearInterval(timer);
	}, [enabled, loadList]);
	const select = useCallback(
		async (id: number) => {
			selectionTicket.current++;
			choose(id);
		},
		[choose],
	);
	const create = useCallback(async () => {
		const ticket = ++selectionTicket.current;
		listTicket.current++;
		const key = (createKey.current ??= crypto.randomUUID());
		const { conversation } = await api(`/agents/${agent.id}/conversations`, {
			method: 'POST',
			body: { requestId: key },
		});
		if (!alive.current) return;
		listTicket.current++;
		if (createKey.current === key) createKey.current = null;
		setConversations((cs) => [conversation, ...cs.filter((c) => c.id !== conversation.id)]);
		if (ticket === selectionTicket.current) choose(conversation.id);
	}, [agent.id, choose, setConversations]);
	const archive = useCallback(
		async (id: number, archived: boolean) => {
			listTicket.current++;
			const { conversation } = await api(`/agents/${agent.id}/conversations/${id}`, {
				method: 'PATCH',
				body: { archived },
			});
			if (!alive.current) return;
			listTicket.current++;
			setConversations((cs) => cs.map((c) => (c.id === id ? conversation : c)));
			if (!archived) {
				selectionTicket.current++;
				choose(id);
			}
		},
		[agent.id, choose, setConversations],
	);
	const selectedConversation = conversations.find((c) => c.id === selected);
	const records = pages[selected ?? 0]?.records ?? [];
	const last = records[records.length - 1]?.task;
	const currentTask =
		agentTask?.conversation_id === selected && (!last || agentTask.id > last.id) ? agentTask : (last ?? null);
	const refresh = useCallback(async () => {
		if (selectedRef.current !== null) await load(selectedRef.current);
	}, [load]);
	return {
		selected,
		selectedConversation,
		pages,
		agentTask,
		currentTask,
		select,
		create,
		archive,
		refresh,
		load,
		loadList,
	};
}

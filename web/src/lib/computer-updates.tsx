import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/api';
import { onComputerUpdate, useConnected } from '@/live';
import {
	jobPending,
	mergeUpdateJob as merge,
	type ComputerUpdateJob,
	type ComputerUpdateOverview,
} from '../../../shared/computer-updates';

type Actions = {
	data: ComputerUpdateOverview;
	refresh: () => Promise<void>;
	/** shutdown: a busy computer is turned off (session closed, task cancelled) instead of waited for. */
	start: (
		agents: { id: number; revision: number }[],
		imageId: string,
		requestId: string,
		shutdown?: boolean,
	) => Promise<ComputerUpdateJob>;
	retry: (id: string, requestId: string) => Promise<void>;
	cancel: (id: string) => Promise<void>;
	/** While a dialog shows the progress itself: no toast when its job ends. Returns the undo. */
	watch: () => () => void;
};
const Context = createContext<Actions | null>(null);
const empty: ComputerUpdateOverview = { target: null, error: null, agents: [], jobs: [] };
export function ComputerUpdatesProvider({
	personId,
	imageRef,
	onChanged,
	children,
}: {
	personId: number;
	imageRef: string;
	onChanged: () => void;
	children: ReactNode;
}) {
	const [data, setData] = useState(empty);
	const jobs = useRef<ComputerUpdateJob[]>([]),
		generation = useRef(0);
	const connected = useConnected();
	// A job that ends is said once, in a toast, unless a dialog is showing it.
	const watching = useRef(0),
		announced = useRef(new Set<string>());
	const announce = useCallback((before: ComputerUpdateJob[], after: ComputerUpdateJob[]) => {
		for (const job of after) {
			const old = before.find((j) => j.id === job.id);
			if (!old || !jobPending(old) || jobPending(job) || announced.current.has(job.id)) continue;
			announced.current.add(job.id);
			if (watching.current) continue;
			const done = job.items.filter((i) => i.status === 'done').length,
				failed = job.items.filter((i) => i.status === 'failed');
			const what = (n: number) => `${n} ${n === 1 ? 'computadora' : 'computadoras'}`;
			if (!failed.length) toast.success(`${what(done)} ${done === 1 ? 'actualizada' : 'actualizadas'}`);
			else
				toast.error(
					done ? `${what(done)} actualizadas; ${failed.length} no se pudieron actualizar` : 'No se pudo actualizar',
					{ description: failed.map((i) => i.name).join(', ') },
				);
		}
	}, []);
	const refresh = useCallback(async () => {
		const request = ++generation.current;
		try {
			const next = await api<ComputerUpdateOverview>('/computer-updates');
			if (request !== generation.current) return;
			const missing = jobs.current.filter((job) => jobPending(job) && !next.jobs.some((j) => j.id === job.id));
			for (const job of missing) {
				const restored = await api<ComputerUpdateJob>(`/computer-updates/${job.id}`).catch(() => null);
				if (restored) next.jobs = merge(next.jobs, restored);
			}
			if (request !== generation.current) return;
			for (const job of jobs.current) if (next.jobs.some((j) => j.id === job.id)) next.jobs = merge(next.jobs, job);
			const completed =
				jobs.current.length > 0 &&
				next.jobs.some((job) =>
					job.items.some(
						(item) =>
							item.status === 'done' &&
							jobs.current.find((old) => old.id === job.id)?.items.find((i) => i.agent_id === item.agent_id)?.status !==
								'done',
					),
				);
			announce(jobs.current, next.jobs);
			jobs.current = next.jobs;
			setData(next);
			if (completed) onChanged();
		} catch (e) {
			if (request === generation.current) setData((old) => ({ ...old, error: (e as Error).message }));
		}
	}, [personId, onChanged, announce]);
	const accept = useCallback(
		(job: ComputerUpdateJob) => {
			const previous = jobs.current.find((j) => j.id === job.id);
			const completed = job.items.some(
				(i) => i.status === 'done' && previous?.items.find((old) => old.agent_id === i.agent_id)?.status !== 'done',
			);
			const before = jobs.current;
			jobs.current = merge(jobs.current, job);
			announce(before, jobs.current);
			setData((old) => ({ ...old, jobs: jobs.current }));
			if (completed || (previous && jobPending(previous) && !jobPending(job))) {
				onChanged();
				void refresh();
			}
		},
		[onChanged, refresh, announce],
	);
	useEffect(() => {
		jobs.current = [];
		setData(empty);
		void refresh();
		return () => {
			generation.current++;
		};
	}, [personId, imageRef]);
	useEffect(
		() =>
			onComputerUpdate((job, owner) => {
				if (owner === personId) accept(job);
			}),
		[personId, accept],
	);
	useEffect(() => {
		if (connected) void refresh();
	}, [connected, refresh]);
	const active = data.jobs.some(jobPending);
	useEffect(() => {
		const check = () => {
			if (!document.hidden) void refresh();
		};
		const timer = setInterval(check, active ? 5000 : 60_000);
		addEventListener('focus', check);
		return () => {
			clearInterval(timer);
			removeEventListener('focus', check);
		};
	}, [active, refresh]);
	const start: Actions['start'] = async (agents, imageId, requestId, shutdown = false) => {
		const job = await api<ComputerUpdateJob>('/computer-updates', { body: { agents, imageId, requestId, shutdown } });
		accept(job);
		void refresh();
		return job;
	};
	const retry = async (id: string, requestId: string) => {
		accept(await api<ComputerUpdateJob>(`/computer-updates/${id}/retry`, { body: { requestId } }));
		void refresh();
	};
	const cancel = async (id: string) => {
		accept(await api<ComputerUpdateJob>(`/computer-updates/${id}/cancel`, { body: {} }));
		void refresh();
	};
	const watch = useCallback(() => {
		watching.current++;
		return () => void watching.current--;
	}, []);
	return <Context.Provider value={{ data, refresh, start, retry, cancel, watch }}>{children}</Context.Provider>;
}
export function useComputerUpdates() {
	const context = useContext(Context);
	if (!context) throw new Error('ComputerUpdatesProvider no está disponible.');
	return context;
}

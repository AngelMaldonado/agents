export type ComputerImage = {
	imageId: string;
	version: string | null;
	piVersion: string | null;
	development: boolean;
	revision: string | null;
	dirty: boolean | null;
	available: boolean;
	notesUrl: string | null;
};
export type ComputerUpdateState = 'queued' | 'waiting' | 'validating' | 'applying' | 'done' | 'failed' | 'cancelled';
export const updatePending = (state: ComputerUpdateState) => !['done', 'failed', 'cancelled'].includes(state);
export const UPDATE_LABEL: Record<ComputerUpdateState, string> = {
	queued: 'En cola',
	waiting: 'Esperando computadora libre',
	validating: 'Probando compatibilidad del harness',
	applying: 'Aplicando revisión',
	done: 'Actualizada',
	failed: 'Fallida',
	cancelled: 'Cancelada',
};
export type ComputerUpdateItem = {
	agent_id: number;
	name: string;
	revision: number;
	status: ComputerUpdateState;
	error: string | null;
	applied_revision: number | null;
};
export type ComputerUpdateJob = {
	id: string;
	target: ComputerImage;
	status: 'queued' | 'preparing' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled';
	message: string | null;
	created_at: number;
	updated_at: number;
	items: ComputerUpdateItem[];
};
export const jobPending = (job: Pick<ComputerUpdateJob, 'status'>) =>
	['queued', 'preparing', 'running'].includes(job.status);
// Events and reconnect snapshots can arrive out of order. Terminal items never become pending again.
export function mergeUpdateJob(jobs: ComputerUpdateJob[], next: ComputerUpdateJob) {
	const previous = jobs.find((job) => job.id === next.id);
	if (
		previous &&
		(previous.updated_at > next.updated_at ||
			(!jobPending(previous) && jobPending(next)) ||
			previous.items.some(
				(old) =>
					!updatePending(old.status) &&
					next.items.some((item) => item.agent_id === old.agent_id && updatePending(item.status)),
			))
	)
		return jobs;
	return [next, ...jobs.filter((job) => job.id !== next.id)].sort((a, b) => b.created_at - a.created_at);
}

export type ComputerUpdateOverview = {
	target: ComputerImage | null;
	error: string | null;
	agents: {
		id: number;
		name: string;
		revision: number;
		currentImage: string | null;
		/** What it runs now, as known (version, Dev commit, pi); null when its image was never described. */
		current: Pick<ComputerImage, 'imageId' | 'version' | 'piVersion' | 'development' | 'revision' | 'dirty'> | null;
		updateAvailable: boolean;
		busy: boolean;
		activeJobId: string | null;
	}[];
	jobs: ComputerUpdateJob[];
};

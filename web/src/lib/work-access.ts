import { isLive, type Task, type TaskEvent } from '@/api';

/** Owners may intervene; shared users only direct the task they requested. */
export const directsTask = (task: Pick<Task, 'person_id' | 'requested_by'>, viewerId: number) =>
	task.person_id === viewerId || task.requested_by === viewerId;

/** A different person's help request must not capture a new task typed in the shared chat. */
export function helpReplyTarget(task: Task | null, events: TaskEvent[], mayDirect: boolean) {
	if (!task || !isLive(task) || !mayDirect || task.kind === 'browser') return null;
	const control = [...events].reverse().find((e) => ['blocked', 'steer', 'unblocked'].includes(e.kind));
	return control?.kind === 'blocked' &&
		!events.some((e) => ['help_answer', 'help_reply'].includes(e.kind) && e.data.round === control.id)
		? { runId: task.id, round: control.id }
		: null;
}

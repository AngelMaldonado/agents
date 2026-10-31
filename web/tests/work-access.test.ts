import { expect, test } from 'bun:test';
import type { Task, TaskEvent } from '../src/api';
import { directsTask, helpReplyTarget } from '../src/lib/work-access';

const task = { id: 10, person_id: 1, requested_by: 2, status: 'blocked', kind: 'task' } as Task;
const blocked = { id: 20, kind: 'blocked', data: {} } as TaskEvent;

test('only the owner and requester direct a shared task', () => {
	expect(directsTask(task, 1)).toBe(true);
	expect(directsTask(task, 2)).toBe(true);
	expect(directsTask(task, 3)).toBe(false);
	expect(directsTask({ ...task, requested_by: null }, 2)).toBe(false);
});

test('a blocked shared task captures replies only from its requester or owner', () => {
	expect(helpReplyTarget(task, [blocked], directsTask(task, 2))).toEqual({ runId: 10, round: 20 });
	expect(helpReplyTarget(task, [blocked], directsTask(task, 1))).toEqual({ runId: 10, round: 20 });
	// Another shared user sends an ordinary queued task, never replyTo for this blocking question.
	expect(helpReplyTarget(task, [blocked], directsTask(task, 3))).toBeNull();
});

test('answered, unblocked, browser and finished tasks cannot capture a new message', () => {
	for (const kind of ['help_answer', 'help_reply']) {
		expect(helpReplyTarget(task, [blocked, { id: 21, kind, data: { round: 20 } } as TaskEvent], true)).toBeNull();
	}
	expect(helpReplyTarget(task, [blocked, { id: 21, kind: 'unblocked', data: {} } as TaskEvent], true)).toBeNull();
	expect(helpReplyTarget({ ...task, status: 'done' }, [blocked], true)).toBeNull();
	expect(helpReplyTarget({ ...task, kind: 'browser' }, [blocked], true)).toBeNull();
	expect(helpReplyTarget(null, [blocked], true)).toBeNull();
});

// Everyone's names (GET /people), to draw who works with an agent. Without it, no faces are drawn.
import { useEffect, useState } from 'react';
import { api, type Person } from '@/api';

export type Someone = Pick<Person, 'id' | 'name'>;

export function usePeople() {
	const [people, setPeople] = useState<Map<number, Someone>>(new Map());
	useEffect(() => {
		api<{ people: Someone[] }>('/people')
			.then((r) => setPeople(new Map(r.people.map((p) => [p.id, p]))))
			.catch(() => {});
	}, []);
	return people;
}

/** The owner first, then the people it is shared with. */
export const crewOf = (agent: { person_id: number; shares?: number[] }, people: Map<number, Someone>) =>
	[agent.person_id, ...(agent.shares ?? [])].flatMap((id) => people.get(id) ?? []);

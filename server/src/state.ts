// AgentState: what an agent keeps between runs: its pi sessions, its ~/work and its browser
// profile. Today a Docker volume per agent on this host (agents.state_ref), mounted at STATE_DIR
// in every run; with a second node it becomes an encrypted archive, behind this same shape.
//
// Inside the volume (the supervisor lays it out):
//   pi/        pi --session-dir; one session per conversation (conversations.pi_session_id)
//   work/      ~/work, kept; work/out/ is emptied at the start of each run
//   browser/   agent-browser's Chrome profile (its cache lives in /tmp, not here)
export const STATE_DIR = '/home/agent/state';

export function stateMount(agent: { id: number; state_ref: string }, instance: string) {
	return {
		name: agent.state_ref,
		target: STATE_DIR,
		labels: { 'agents.instance': instance, 'agents.agent': String(agent.id) },
	};
}

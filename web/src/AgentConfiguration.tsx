import { useEffect, useState } from 'react';
import { api, type Agent, type AgentTool, type Harness } from './api';

type Configuration = {
	agent: Agent;
	tools: AgentTool[];
	credentialNames: string[];
	effectivePrompt: string;
	draftId: string | null;
	setupDesignId: string | null;
	harness?: Harness;
	revisions?: { revision: number; name: string; model: string; created_at: number }[];
};
export function useAgentConfiguration(agent: Agent) {
	const [data, setData] = useState<Configuration | null>(null);
	const [error, setError] = useState('');
	const [reload, setReload] = useState(0);
	useEffect(() => {
		let alive = true;
		api<Configuration>(`/agents/${agent.id}/configuration`)
			.then((r) => {
				if (alive) {
					setData(r);
					setError('');
				}
			})
			.catch((err) => {
				if (alive) setError(err.message);
			});
		return () => {
			alive = false;
		};
	}, [agent.id, agent.config_revision, reload]);
	return { data, error, retry: () => setReload((n) => n + 1) };
}

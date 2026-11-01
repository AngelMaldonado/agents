// "Open this agent at that conversation" (a search result in the sidebar). In memory, not in the URL:
// the agent view may still be loading when it is asked, the same result can be clicked twice, and a
// stale /c/<id> in the URL would keep pulling the view back to it after the person changes tabs.
type Request = { agentId: number; conversationId: number; at: number };

let pending: Request | null = null;
const listeners = new Set<(r: Request) => void>();

export function requestConversation(agentId: number, conversationId: number) {
	pending = { agentId, conversationId, at: Date.now() };
	for (const fn of listeners) fn(pending);
}

/** The pending request for this agent, if any; it stays until taken. */
export const pendingConversation = (agentId: number) => (pending?.agentId === agentId ? pending : null);

export function takeConversation(r: Request) {
	if (pending === r) pending = null;
}

export function onConversationRequest(fn: (r: Request) => void) {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}

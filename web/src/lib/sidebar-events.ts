// Something the sidebar lists changed outside it (a draft got its first reply or a new name).
export const SIDEBAR_CHANGED = 'agents:sidebar-changed';
export const sidebarChanged = () => window.dispatchEvent(new Event(SIDEBAR_CHANGED));

// «Compartir» from the sidebar: the agent's hub opens its settings at that section once it is on screen.
export const SHARE_REQUEST = 'agents:share-request';
let pendingShare: { agentId: number; at: number } | null = null;
export function requestShare(agentId: number) {
	pendingShare = { agentId, at: Date.now() };
	window.dispatchEvent(new Event(SHARE_REQUEST));
}
/** The pending request for this agent (consumed), or null. */
export function takeShareRequest(agentId: number) {
	if (pendingShare?.agentId !== agentId) return null;
	const at = pendingShare.at;
	pendingShare = null;
	return at;
}

// «Usar para mejorar» a chat: Automejora opens with it cited, to say what the agent did wrong there.
export const IMPROVE_REQUEST = 'agents:improve-request';
let pendingImprove: { agentId: number; chat: { id: number; title: string } } | null = null;
export function improveWith(agentId: number, chat: { id: number; title: string }) {
	pendingImprove = { agentId, chat };
	location.hash = `/agent/${agentId}/improve`;
	window.dispatchEvent(new Event(IMPROVE_REQUEST));
}
/** The chat to cite in this agent's Automejora (consumed), or null. */
export function takeImproveRequest(agentId: number) {
	if (pendingImprove?.agentId !== agentId) return null;
	const chat = pendingImprove.chat;
	pendingImprove = null;
	return chat;
}

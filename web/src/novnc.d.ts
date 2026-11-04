// noVNC 1.4 ships no types (1.5+ break the build: a top-level await in its CommonJS lib); only what the desktop view (#27) uses.
declare module '@novnc/novnc/lib/rfb' {
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: Record<string, unknown>);
		scaleViewport: boolean;
		resizeSession: boolean;
		viewOnly: boolean;
		disconnect(): void;
	}
}

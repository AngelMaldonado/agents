// A page can take over the app bar's title (the agent's chat view puts its breadcrumb and actions
// there, like Claude's). The shell owns the element; a page portals into it while it is mounted.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const HeaderSlotContext = createContext<HTMLElement | null>(null);

/** Renders its children in the app bar instead of the page title, while it is mounted. */
export function HeaderSlot({ children }: { children: ReactNode }) {
	const slot = useContext(HeaderSlotContext);
	return slot ? createPortal(children, slot) : null;
}

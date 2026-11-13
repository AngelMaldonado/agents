// The app's own confirmation (instead of the browser's confirm()): a dialog with what happens and two buttons.
// `const [ask, confirmDialog] = useConfirm()`; render `confirmDialog`; `if (await ask({...}))` goes on.
import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';

export type ConfirmOptions = {
	title: string;
	description?: ReactNode;
	/** The button that goes on (default «Confirmar»). */
	action?: string;
	/** It stops, deletes or ends something: the button in red. */
	destructive?: boolean;
};

export function useConfirm() {
	const [request, setRequest] = useState<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);
	const ask = useCallback(
		(options: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
		[],
	);
	const answer = (ok: boolean) => {
		request?.resolve(ok);
		setRequest(null);
	};
	const dialog = (
		<Dialog open={!!request} onOpenChange={(open) => !open && answer(false)}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{request?.title}</DialogTitle>
					{request?.description && <DialogDescription>{request.description}</DialogDescription>}
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => answer(false)}>
						Cancelar
					</Button>
					<Button variant={request?.destructive ? 'destructive' : 'default'} autoFocus onClick={() => answer(true)}>
						{request?.action ?? 'Confirmar'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
	return [ask, dialog] as const;
}

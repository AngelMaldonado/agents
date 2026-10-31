// Copy a chat message (its text, as markdown), with assistant-ui's action bar.
import { ActionBarPrimitive, AuiIf } from '@assistant-ui/react';
import { Check, Copy } from 'lucide-react';
import { Button } from './ui/button';

export function CopyMessage() {
	return (
		<ActionBarPrimitive.Root className="message-actions">
			<ActionBarPrimitive.Copy asChild copiedDuration={1500}>
				<Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Copiar mensaje" title="Copiar">
					<AuiIf condition={(s) => s.message.isCopied}>
						<Check aria-hidden="true" />
					</AuiIf>
					<AuiIf condition={(s) => !s.message.isCopied}>
						<Copy aria-hidden="true" />
					</AuiIf>
				</Button>
			</ActionBarPrimitive.Copy>
		</ActionBarPrimitive.Root>
	);
}

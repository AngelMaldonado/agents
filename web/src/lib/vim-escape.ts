// Esc in a prompt editor with Vim on leaves insert mode: the dialog around it must stay open (Radix
// closes a dialog on Escape before CodeMirror hears it). For a DialogContent's onEscapeKeyDown.
export function keepOpenForVim(event: KeyboardEvent) {
	if ((event.target as Element | null)?.closest?.('.role-editor[data-vim-enabled="true"] .cm-editor'))
		event.preventDefault();
}

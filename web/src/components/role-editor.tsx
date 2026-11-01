import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { getCM, Vim, vim } from '@replit/codemirror-vim';
import { Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/lib/theme';

const theme = {
	'&': { backgroundColor: 'var(--card)', color: 'var(--foreground)', fontSize: 'var(--text-xs)' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
	'.cm-content': { padding: '.75rem 0', minHeight: '17rem', caretColor: 'var(--primary)' },
	'.cm-gutters': {
		backgroundColor: 'var(--muted)',
		color: 'var(--muted-foreground)',
		borderRight: '1px solid var(--border)',
	},
	'.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
		backgroundColor: 'color-mix(in srgb, var(--primary) 25%, transparent)',
	},
	'.cm-panels': { backgroundColor: 'var(--muted)', color: 'var(--foreground)', borderColor: 'var(--border)' },
	'.cm-search input, .cm-textfield': {
		backgroundColor: 'var(--background)',
		color: 'var(--foreground)',
		borderColor: 'var(--border)',
	},
	'.cm-vimCursorLayer .cm-fat-cursor': { backgroundColor: 'var(--primary)', opacity: '.55' },
	'&.cm-focused': { outline: 'none' },
};

export function RoleEditor({
	value,
	onChange,
	disabled,
	label = 'Rol e instrucciones',
	fill = false,
	leading,
	actions,
}: {
	value: string;
	onChange: (value: string) => void;
	disabled?: boolean;
	/** The document's name, over the editor and for screen readers. */
	label?: string;
	/** Takes the height of its container (Configuración → Harness) instead of a fixed 20rem. */
	fill?: boolean;
	/** In place of the label, at the start of the header (Harness: «Volver», title and subtitle). */
	leading?: ReactNode;
	/** Before the Vim toggle, at the end of the header (Harness: «Guardar»). */
	actions?: ReactNode;
}) {
	const { mode } = useTheme();
	const [vimEnabled, setVimEnabled] = useState(true);
	const id = useId();
	const view = useRef<EditorView | null>(null);
	const extensions = useMemo(
		() => [
			...(vimEnabled ? [vim({ status: true })] : []),
			markdown(),
			EditorView.lineWrapping,
			Prec.high(EditorView.theme(theme, { dark: mode === 'dark' })),
			EditorView.contentAttributes.of({
				'aria-label': label,
				'aria-describedby': id,
				role: 'textbox',
				'aria-multiline': 'true',
			}),
			EditorState.transactionFilter.of((transaction) => (transaction.newDoc.length > 16000 ? [] : transaction)),
		],
		[vimEnabled, id, mode, label],
	);
	return (
		<section
			className={`role-editor min-w-0 overflow-hidden${fill ? ' role-editor-fill' : ' rounded-lg border'}`}
			aria-label={`Editor: ${label}`}
			data-vim-enabled={vimEnabled}
			onKeyDownCapture={(event) => {
				// Radix handles Escape on document capture, before CodeMirror can exit insert mode.
				// The dialog keeps itself open; dispatch the Vim key here, once, before the editor.
				if (event.key === 'Escape' && vimEnabled && view.current && (event.target as Element).closest('.cm-editor')) {
					const cm = getCM(view.current);
					if (cm) Vim.handleKey(cm, '<Esc>', 'user');
					event.preventDefault();
					event.stopPropagation();
				}
			}}
		>
			<div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-3 py-2">
				{leading ?? (
					<span className="flex min-w-0 items-center gap-2 text-xs font-medium">
						<Code2 className="size-4" aria-hidden="true" />
						{label} <span className="text-muted-foreground">· Markdown</span>
					</span>
				)}
				<div className="flex shrink-0 items-center gap-2">
					{actions}
					<Button
						type="button"
						size="xs"
						variant="outline"
						className="aria-pressed:border-primary/60 aria-pressed:text-primary"
						aria-pressed={vimEnabled}
						disabled={disabled}
						onClick={() => setVimEnabled((value) => !value)}
					>
						Vim
					</Button>
				</div>
			</div>
			<CodeMirror
				onCreateEditor={(editor) => {
					view.current = editor;
				}}
				value={value}
				extensions={extensions}
				theme={mode}
				height={fill ? '100%' : '20rem'}
				editable={!disabled}
				readOnly={disabled}
				indentWithTab={false}
				onChange={onChange}
				basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false, highlightActiveLine: true }}
			/>
			<p id={id} className="border-t px-3 py-2 text-2xs text-muted-foreground">
				{vimEnabled
					? 'Vim: i para insertar · Esc para modo normal · Tab para salir del editor.'
					: 'Edición estándar · Tab para salir del editor.'}{' '}
				<span className="tnum">{value.length.toLocaleString('es-MX')} / 16,000</span>
			</p>
		</section>
	);
}

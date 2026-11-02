// A ```mermaid block drawn as a diagram (the contract's flows). Mermaid is large: it loads on the
// first diagram. Strict security (no HTML labels, no click handlers); if a diagram does not parse,
// its source stays visible.
import { useEffect, useId, useState } from 'react';
import { useTheme } from '@/lib/theme';

let loading: Promise<typeof import('mermaid').default> | null = null;
const load = () => (loading ??= import('mermaid').then((m) => m.default));

export function MermaidDiagram({ chart }: { chart: string }) {
	const { mode } = useTheme();
	const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
	const [svg, setSvg] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let alive = true;
		void load()
			.then(async (mermaid) => {
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: 'strict',
					theme: mode === 'dark' ? 'dark' : 'neutral',
					fontFamily: 'inherit',
					flowchart: { htmlLabels: false, useMaxWidth: true },
				});
				const { svg } = await mermaid.render(`${id}-${mode}`, chart);
				if (alive) {
					setSvg(svg);
					setFailed(false);
				}
			})
			.catch(() => alive && setFailed(true));
		return () => {
			alive = false;
		};
	}, [chart, mode, id]);
	if (failed)
		return (
			<figure className="mermaid-diagram">
				<pre>
					<code>{chart}</code>
				</pre>
				<figcaption className="text-2xs text-muted-foreground">No se pudo dibujar el diagrama.</figcaption>
			</figure>
		);
	return svg ? (
		<figure
			className="mermaid-diagram"
			role="img"
			aria-label="Diagrama de flujo"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	) : (
		<p role="status" className="text-2xs text-muted-foreground">
			Dibujando diagrama…
		</p>
	);
}

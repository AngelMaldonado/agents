// A trabajo's playbook (Angel 13-nov-2026), in its description: the lessons its agent worked with (put
// together from its Aprendizajes when the trabajo started, or when its objective changed) and why each one,
// and what the trabajo taught it: what it saved while working, what its evaluator changed, what its owner
// taught.
import { Check, Clock, GraduationCap, Minus, Pencil, Pin, Plus, Search, Star, X, type LucideIcon } from 'lucide-react';

export type Why = 'fijado' | 'relevante' | 'útil' | 'reciente';
export type PlaybookEntry = {
	id: number;
	text: string;
	why: Why;
	helpful: number;
	harmful: number;
	pinned: boolean;
	conversation_id: number | null;
};
export type Taught = {
	op: 'learn' | 'teach' | 'add' | 'update' | 'helpful' | 'harmful' | 'remove';
	text: string;
	at: number;
};
/** What a trabajo taught that is new: saved, taught, added or corrected (not a mark on what it knew). */
export const NEW_OPS: Taught['op'][] = ['learn', 'teach', 'add', 'update'];

const WHY: Record<Why, { icon: LucideIcon; label: string }> = {
	fijado: { icon: Pin, label: 'fijado' },
	relevante: { icon: Search, label: 'relevante' },
	útil: { icon: Star, label: 'útil' },
	reciente: { icon: Clock, label: 'reciente' },
};
const OP: Record<Taught['op'], { icon: LucideIcon; label: string; tone?: 'good' | 'bad' }> = {
	learn: { icon: Plus, label: 'lo guardó trabajando', tone: 'good' },
	teach: { icon: GraduationCap, label: 'se lo enseñaste', tone: 'good' },
	add: { icon: Plus, label: 'nuevo', tone: 'good' },
	update: { icon: Pencil, label: 'corregido' },
	helpful: { icon: Check, label: 'le sirvió', tone: 'good' },
	harmful: { icon: X, label: 'causó un error', tone: 'bad' },
	remove: { icon: Minus, label: 'quitado', tone: 'bad' },
};

export function JobPlaybook({ playbook = [], taught = [] }: { playbook?: PlaybookEntry[]; taught?: Taught[] }) {
	if (!playbook.length && !taught.length) return null;
	return (
		<div className="job-playbook">
			{playbook.length > 0 && (
				<>
					<strong>Playbook de este trabajo.</strong>
					<ul className="job-playbook-list">
						{playbook.map((e) => {
							const w = WHY[e.why];
							return (
								<li key={e.id}>
									<w.icon className={`job-playbook-icon is-${e.why}`} aria-hidden="true" />
									<span className="min-w-0 flex-1">{e.text}</span>
									<span className="job-playbook-meta">
										{w.label}
										{e.helpful ? ` · útil ${e.helpful}` : ''}
										{e.conversation_id ? ` · #${e.conversation_id}` : ''}
									</span>
								</li>
							);
						})}
					</ul>
				</>
			)}
			{taught.length > 0 && (
				<>
					<strong>Lo que le enseñó.</strong>
					<ul className="job-playbook-list">
						{taught.map((t, i) => {
							const o = OP[t.op];
							return (
								<li key={`${t.at}-${i}`}>
									<o.icon className={`job-playbook-icon ${o.tone ? `is-${o.tone}` : ''}`} aria-hidden="true" />
									<span className="min-w-0 flex-1">{t.text}</span>
									<span className="job-playbook-meta">{o.label}</span>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</div>
	);
}

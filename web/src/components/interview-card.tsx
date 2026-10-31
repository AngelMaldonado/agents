import { createContext, useContext } from 'react';
import type { Design, InterviewAnswers } from '@/api';
import { Questionnaire, type QuestionDraft } from './questionnaire';
export type InterviewDraft = QuestionDraft;
export type InterviewDrafts = Record<number, InterviewDraft>;
export const InterviewContext = createContext<{
	design: Design | null;
	drafts: InterviewDrafts;
	update: (round: number, patch: Partial<InterviewDraft>) => void;
	onAnswer: (answers: InterviewAnswers) => Promise<void>;
	blocked: boolean;
	working: boolean;
	unsent: boolean;
} | null>(null);
// Same controlled QuestionFlow in design and work: neither surface grants tool authority.
export function InterviewCard({ index }: { index: number }) {
	const ctx = useContext(InterviewContext)!;
	const m = ctx.design?.messages[index];
	if (!ctx.design || !m?.questions?.length || !m.questionRound) return null;
	const round = m.questionRound,
		questions = m.questions;
	const answered = ctx.design.messages.find((message) => message.answers?.round === round)?.answers;
	if (!answered && ctx.design.interview?.pending?.round !== round)
		return (
			<details className="mt-3 text-xs text-muted-foreground">
				<summary>Ronda anterior, reemplazada</summary>
				<ul className="mt-2 list-disc pl-4">
					{questions.map((q) => (
						<li key={q.id}>{q.title}</li>
					))}
				</ul>
			</details>
		);
	return (
		<Questionnaire
			id={`${ctx.design.id}:questions:${round}`}
			round={round}
			questions={questions}
			answered={answered}
			draft={ctx.drafts[round] ?? { value: {}, other: {} }}
			update={(patch) => ctx.update(round, patch)}
			onAnswer={ctx.onAnswer}
			blocked={ctx.blocked}
			working={ctx.working}
			unsent={ctx.unsent}
			legend="Cuestionario para definir el agente"
		/>
	);
}

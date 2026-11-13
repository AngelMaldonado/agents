import { expect, test } from 'bun:test';
import { inQuietHours, noticeRules, quietHours, settings } from './settings';
import { systemPrompt } from './prompt';

const base = settings();

test('quiet hours and notice limits come from the configuration', () => {
	const night = { ...base, quietFrom: 22, quietTo: 7, noticesPerDay: 10 };
	expect([21, 22, 23, 0, 6, 7].map((h) => inQuietHours(h, night))).toEqual([false, true, true, true, true, false]);
	expect(noticeRules(night)).toBe(
		'hasta 10 avisos al día por persona; de 22:00 a 07:00 quedan programados para las 07:00, salvo urgentes',
	);
	// The same day (13 to 15), none at all, and no cap.
	const siesta = { ...base, quietFrom: 13, quietTo: 15, noticesPerDay: 0 };
	expect([12, 13, 14, 15].map((h) => inQuietHours(h, siesta))).toEqual([false, true, true, false]);
	expect(noticeRules(siesta)).toBe(
		'sin tope de avisos al día; de 13:00 a 15:00 quedan programados para las 15:00, salvo urgentes',
	);
	const open = { ...base, quietFrom: 8, quietTo: 8 };
	expect(quietHours(open)).toBeNull();
	expect(inQuietHours(8, open)).toBe(false);
	expect(noticeRules(open)).toContain('sin horario de silencio');
});

test('the agent is told its notice limits only when it can send notices', () => {
	expect(systemPrompt({ name: 'X', role: 'r', notices: true }, [])).toContain(
		`Tus avisos con \`whatsapp_notify\`: ${noticeRules()}.`,
	);
	expect(systemPrompt({ name: 'X', role: 'r' }, [])).not.toContain('Tus avisos con');
});

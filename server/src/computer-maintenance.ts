// Shared with run admission and the inbox; no workflow imports/cycles.
import { row, type Exec } from './db';
export class ComputerUpdating extends Error {
	constructor() {
		super(
			'Esta computadora tiene una actualización programada o reparación autorizada. Tus mensajes esperarán en el inbox.',
		);
	}
}
export const maintenancePending = (id: number, on?: Exec) =>
	row(
		`select 1 from computer_update_items where agent_id=$1 and status in ('queued','waiting','validating','applying')
		union all select 1 from agent_repairs where agent_id=$1 and status in ('approved','running') and action->>'kind' <> 'install'`,
		[id],
		on,
	);

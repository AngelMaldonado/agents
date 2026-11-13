import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import esLocale from '@fullcalendar/core/locales/es';
import type { DatesSetArg } from '@fullcalendar/core';
import { DateTime } from 'luxon';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import {
	cronFromDraft,
	expandSchedules,
	nextRuns,
	zoneLabel,
	type Schedule,
	type ScheduleDraft,
} from '@/lib/schedules';
import { Button } from '@/components/ui/button';
import { SaveButton, useSaving } from '@/components/actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { OptionSelect } from '@/components/option-select';

type Props = {
	schedules: Schedule[];
	timezone: string;
	add?: (cron: string, message: string) => Promise<string | null>;
	toggle?: (schedule: Schedule) => Promise<string | null>;
	remove?: (schedule: Schedule) => Promise<string | null>;
	/** A proposal (the designer's): only the agenda and each schedule's prompt, nothing to change. */
	readOnly?: boolean;
	height?: number;
};
const when = (d: Date, timezone: string) =>
	d.toLocaleString('es-MX', {
		timeZone: timezone,
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
	});
const views = [
	{ id: 'dayGridMonth', label: 'Mes' },
	{ id: 'timeGridWeek', label: 'Semana' },
	{ id: 'listWeek', label: 'Agenda' },
];
const days = [
	{ id: 1, label: 'Lunes' },
	{ id: 2, label: 'Martes' },
	{ id: 3, label: 'Miércoles' },
	{ id: 4, label: 'Jueves' },
	{ id: 5, label: 'Viernes' },
	{ id: 6, label: 'Sábado' },
	{ id: 0, label: 'Domingo' },
];

export function ScheduleCalendar({ schedules, timezone, add, toggle, remove, readOnly = false, height = 480 }: Props) {
	const calendar = useRef<FullCalendar>(null);
	const container = useRef<HTMLDivElement>(null);
	const [view, setView] = useState(() => (window.innerWidth < 768 ? 'listWeek' : 'timeGridWeek'));
	const [range, setRange] = useState<{ start: string; end: string } | null>(null);
	const [title, setTitle] = useState('');
	const [creatingBusy, setCreatingBusy] = useState(false);
	const [creation, setCreation] = useState<{ date: string; fromCalendar: boolean } | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [deleting, setDeleting] = useState(false);
	const schedule = schedules.find((schedule) => schedule.name === selected);
	const preview = useMemo(
		() =>
			range ? expandSchedules(schedules, range.start, range.end, timezone) : { events: [], limited: [], invalid: [] },
		[schedules, range, timezone],
	);
	const datesSet = useCallback((info: DatesSetArg) => {
		setTitle(info.view.title);
		setRange((old) =>
			old?.start === info.startStr && old.end === info.endStr ? old : { start: info.startStr, end: info.endStr },
		);
	}, []);
	useEffect(() => {
		let width = -1,
			frame = 0;
		const observer = new ResizeObserver((entries) => {
			const next = entries[0].contentRect.width;
			if (next === width) return;
			width = next;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => calendar.current?.getApi().updateSize());
		});
		observer.observe(container.current!);
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, []);
	const inspect = (name: string) => {
		setSelected(name);
		setError('');
		setDeleting(false);
	};
	const perform = async (operation: () => Promise<string | null>) => {
		if (busy) return;
		setBusy(true);
		setError('');
		try {
			const message = await operation();
			if (message) setError(message);
			else {
				setSelected(null);
				setDeleting(false);
			}
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="schedule-calendar min-w-0" aria-label="Agenda de horarios">
			<div className="mb-3 flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2">
						<CalendarDays className="size-4 text-primary" aria-hidden="true" />
						Agenda de horarios
					</h2>
					<p className="mt-1 text-xs text-muted-foreground">
						{zoneLabel(timezone)} · Cada bloque marca un disparo, no la duración de una tarea.
					</p>
				</div>
				{!readOnly && (
					<Button
						size="sm"
						onClick={() =>
							setCreation({
								date: DateTime.now().setZone(timezone).set({ hour: 9, minute: 0 }).toISO()!,
								fromCalendar: false,
							})
						}
					>
						<Plus aria-hidden="true" />
						Nuevo horario
					</Button>
				)}
			</div>
			<div className="schedule-toolbar mb-3 flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Periodo anterior"
					onClick={() => calendar.current?.getApi().prev()}
				>
					<ChevronLeft />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Periodo siguiente"
					onClick={() => calendar.current?.getApi().next()}
				>
					<ChevronRight />
				</Button>
				<Button variant="outline" size="sm" onClick={() => calendar.current?.getApi().today()}>
					Hoy
				</Button>
				<span className="min-w-0 flex-1 text-xs font-medium" aria-live="polite">
					{title}
				</span>
				<div className="w-28">
					<OptionSelect
						label="Vista del calendario"
						value={view}
						options={views}
						onValueChange={(value) => {
							setView(value);
							calendar.current?.getApi().changeView(value);
						}}
					/>
				</div>
			</div>
			<div ref={container} className="min-w-0 overflow-hidden rounded-lg border">
				<FullCalendar
					ref={calendar}
					plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin]}
					initialView={view}
					locale={esLocale}
					timeZone={timezone}
					headerToolbar={false}
					datesSet={datesSet}
					events={preview.events}
					height={height}
					firstDay={1}
					fixedWeekCount={false}
					allDaySlot={false}
					nowIndicator
					dayMaxEvents={3}
					eventInteractive
					editable={false}
					defaultTimedEventDuration="00:10:00"
					eventMinHeight={24}
					slotDuration="00:30:00"
					scrollTime="08:00:00"
					slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
					eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
					dateClick={readOnly ? undefined : (info) => setCreation({ date: info.dateStr, fromCalendar: true })}
					eventClick={(info) =>
						readOnly
							? document.getElementById(`schedule-${info.event.extendedProps.scheduleName}`)?.scrollIntoView({
									behavior: 'smooth',
									block: 'nearest',
								})
							: inspect(info.event.extendedProps.scheduleName)
					}
				/>
			</div>
			{!!preview.limited.length && (
				<p role="status" className="callout mt-3 text-xs">
					Vista previa limitada: hay horarios con demasiados disparos en este rango. No limita la ejecución.
				</p>
			)}
			{!!preview.invalid.length && (
				<p role="status" className="error mt-3 text-xs">
					No se pudo proyectar {preview.invalid.length} horario(s): ábrelos abajo y revisa su cron.
				</p>
			)}
			{readOnly ? (
				<ul className="mt-4 grid min-w-0 gap-3" aria-label="Horarios propuestos">
					{schedules.map((s) => (
						<li key={s.name} id={`schedule-${s.name}`} className="min-w-0 rounded-lg border p-3 text-xs">
							<p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
								<code className="font-medium">{s.cron}</code>
								{s.status === 'PAUSED' && <span className="text-muted-foreground">en pausa</span>}
							</p>
							<p className="mt-1 text-2xs text-muted-foreground">
								Próximas:{' '}
								{nextRuns(s.cron, 3, timezone)
									.map((d) => when(d, timezone))
									.join(' · ') || 'no se pudo calcular'}
							</p>
							<p className="mt-3 mb-1 text-2xs font-medium text-muted-foreground">Prompt</p>
							<p className="whitespace-pre-wrap break-words">{s.message}</p>
						</li>
					))}
				</ul>
			) : (
				// Only those the calendar could not draw (an invalid cron): elsewhere, a click on its block opens it.
				<div className="mt-4 grid min-w-0 gap-2" aria-label="Horarios que no se pudieron proyectar">
					{schedules
						.filter((schedule) => preview.invalid.includes(schedule.name))
						.map((schedule) => (
							<Button
								key={schedule.name}
								variant="outline"
								className="h-auto! justify-start whitespace-normal px-3 py-3 text-left"
								onClick={() => inspect(schedule.name)}
							>
								<span className="min-w-0">
									<span className="block break-words font-medium">{schedule.message}</span>
									<span className="mt-1 block break-words text-2xs text-muted-foreground">
										{schedule.status === 'PAUSED' ? 'En pausa' : 'Activo'} · <code>{schedule.cron}</code>
									</span>
								</span>
							</Button>
						))}
				</div>
			)}
			<Dialog
				open={!!creation}
				onOpenChange={(value) => {
					if (!value && !creatingBusy) setCreation(null);
				}}
			>
				<DialogContent
					className="sm:max-w-lg"
					onEscapeKeyDown={(event) => {
						if (creatingBusy) event.preventDefault();
					}}
					onPointerDownOutside={(event) => {
						if (creatingBusy) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>Nuevo horario</DialogTitle>
						<DialogDescription>
							Se repetirá en {zoneLabel(timezone)} a partir de guardar. La fecha elegida indica el día de recurrencia,
							no una primera ejecución diferida. Si está ocupado, entrará como seguimiento.
						</DialogDescription>
					</DialogHeader>
					{creation && add && (
						<ScheduleForm
							key={creation.date}
							date={creation.date}
							fromCalendar={creation.fromCalendar}
							timezone={timezone}
							add={add}
							onBusy={setCreatingBusy}
							onDone={() => setCreation(null)}
						/>
					)}
				</DialogContent>
			</Dialog>
			<Dialog
				open={!!schedule}
				onOpenChange={(value) => {
					if (!busy && !value) setSelected(null);
				}}
			>
				<DialogContent
					className="sm:max-w-lg"
					onEscapeKeyDown={(event) => {
						if (busy) event.preventDefault();
					}}
					onPointerDownOutside={(event) => {
						if (busy) event.preventDefault();
					}}
				>
					<DialogHeader>
						<DialogTitle>Horario recurrente</DialogTitle>
						<DialogDescription>
							Las acciones afectan a toda la recurrencia, no sólo al bloque seleccionado.
						</DialogDescription>
					</DialogHeader>
					{schedule && (
						<div className="grid min-w-0 gap-4">
							<p className="whitespace-pre-wrap break-words">{schedule.message}</p>
							<p className="text-xs text-muted-foreground">
								{schedule.status === 'PAUSED' ? 'En pausa' : 'Activo'} · {zoneLabel(schedule.timezone || timezone)}
								<br />
								<code className="break-words">{schedule.cron}</code>
							</p>
							<p className="text-2xs text-muted-foreground">
								Para cambiar una regla, crea su reemplazo y elimina la anterior. No se transforma automáticamente un
								cron existente.
							</p>
							{error && (
								<p role="alert" className="error">
									{error}
								</p>
							)}
							{deleting ? (
								<div className="rounded-lg border border-destructive/30 bg-danger-soft/30 p-3">
									<p className="mb-3 text-xs">¿Eliminar todos los próximos disparos de este horario?</p>
									<div className="flex flex-wrap gap-2">
										<Button variant="outline" size="sm" disabled={busy} onClick={() => setDeleting(false)}>
											Conservar horario
										</Button>
										<Button
											variant="destructive"
											size="sm"
											disabled={busy}
											onClick={() => void perform(() => remove!(schedule))}
										>
											Confirmar eliminación
										</Button>
									</div>
								</div>
							) : (
								<div className="flex flex-wrap justify-between gap-2">
									<Button variant="outline" disabled={busy} onClick={() => void perform(() => toggle!(schedule))}>
										{schedule.status === 'PAUSED' ? 'Reanudar horario' : 'Pausar horario'}
									</Button>
									<Button variant="danger-ghost" disabled={busy} onClick={() => setDeleting(true)}>
										Eliminar horario
									</Button>
								</div>
							)}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}

function ScheduleForm({
	date,
	fromCalendar,
	timezone,
	add,
	onDone,
	onBusy,
}: {
	date: string;
	fromCalendar: boolean;
	timezone: string;
	add: NonNullable<Props['add']>;
	onDone: () => void;
	onBusy: (value: boolean) => void;
}) {
	const selected = DateTime.fromISO(date, { zone: timezone });
	const [frequency, setFrequency] = useState<ScheduleDraft['frequency']>(fromCalendar ? 'weekly' : 'weekdays');
	const [time, setTime] = useState(date.includes('T') ? selected.toFormat('HH:mm') : '09:00');
	const [weekdays, setWeekdays] = useState([selected.weekday % 7]);
	const [monthDay, setMonthDay] = useState(selected.day);
	const [custom, setCustom] = useState('0 9 * * 1-5');
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState(false);
	const saving = useSaving();
	const [error, setError] = useState('');
	const [hour, minute] = time.split(':').map(Number);
	let cron = '',
		validation = '';
	try {
		cron = cronFromDraft({ frequency, hour, minute, days: weekdays, dayOfMonth: monthDay, cron: custom });
	} catch (err) {
		validation = (err as Error).message;
	}
	return (
		<form
			className="form"
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy || validation || !message.trim()) return;
				setBusy(true);
				onBusy(true);
				setError('');
				try {
					await saving.run(
						async () => {
							const error = await add(cron, message);
							if (error) throw new Error(error);
						},
						{ hold: true },
					);
					onDone();
				} catch (err) {
					setError((err as Error).message);
				} finally {
					setBusy(false);
					onBusy(false);
				}
			}}
		>
			<fieldset disabled={busy} className="field-list min-w-0">
				<label className="field">
					<span>Repetir</span>
					<OptionSelect
						label="Repetir horario"
						value={frequency}
						options={[
							{ id: 'weekdays', label: 'De lunes a viernes' },
							{ id: 'daily', label: 'Todos los días' },
							{ id: 'weekly', label: 'Cada semana' },
							{ id: 'monthly', label: 'Cada mes' },
							{ id: 'custom', label: 'Cron avanzado' },
						]}
						onValueChange={(value) => setFrequency(value as ScheduleDraft['frequency'])}
						disabled={busy}
					/>
				</label>
				{frequency !== 'custom' && (
					<label className="field">
						<span>Hora</span>
						<Input
							aria-label="Hora del horario"
							type="time"
							value={time}
							onChange={(event) => setTime(event.target.value)}
							required
						/>
					</label>
				)}
				{frequency === 'weekly' && (
					<div className="field" role="group" aria-labelledby="schedule-days">
						<span id="schedule-days">Días de la semana</span>
						<div className="flex flex-wrap gap-2">
							{days.map((day) => (
								<Button
									type="button"
									key={day.id}
									size="sm"
									aria-label={day.label}
									aria-pressed={weekdays.includes(day.id)}
									variant="outline"
									className="aria-pressed:border-primary/60 aria-pressed:text-primary"
									onClick={() =>
										setWeekdays((current) =>
											current.includes(day.id) ? current.filter((id) => id !== day.id) : [...current, day.id],
										)
									}
								>
									{day.label.slice(0, 2)}
								</Button>
							))}
						</div>
					</div>
				)}
				{frequency === 'monthly' && (
					<label className="field">
						<span>Día del mes</span>
						<Input
							type="number"
							min={1}
							max={31}
							value={monthDay}
							onChange={(event) => setMonthDay(event.target.valueAsNumber)}
							required
						/>
						<span className="field-hint text-2xs text-muted-foreground">
							Si el mes no tiene ese día, no se dispara ese mes.
						</span>
					</label>
				)}
				{frequency === 'custom' && (
					<label className="field">
						<span>Expresión cron</span>
						<Input
							value={custom}
							onChange={(event) => setCustom(event.target.value)}
							placeholder="0 9 * * 1-5"
							required
						/>
					</label>
				)}
				<label className="field">
					<span>Mensaje del horario</span>
					<Textarea
						aria-label="Mensaje del horario"
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						rows={4}
						maxLength={4000}
						placeholder="Revisa novedades y prepara un resumen."
						required
					/>
				</label>
			</fieldset>
			{validation ? (
				<p role="status" className="error text-xs">
					{validation}
				</p>
			) : (
				<p className="text-2xs text-muted-foreground">
					Regla resultante: <code>{cron}</code> · {zoneLabel(timezone)}
				</p>
			)}
			{error && (
				<p role="alert" className="error">
					{error}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-2">
				<Button type="button" variant="outline" disabled={busy} onClick={onDone}>
					Cancelar
				</Button>
				<SaveButton state={saving.state} disabled={busy || !!validation || !message.trim()}>
					Crear horario
				</SaveButton>
			</div>
		</form>
	);
}

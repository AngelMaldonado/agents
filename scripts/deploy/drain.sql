-- Sólo lectura, ejecutar dentro de cada Postgres de origen con los argv de just cutover plan.
-- No mueve ni cancela corridas; no limpia leases vencidas para fabricar un cero.
-- Ejecutar otra vez DESPUÉS de detener los escritores: una observación antes no es un freeze.
DO $$ BEGIN
  IF current_database() <> 'agents' OR current_setting('default_transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'drain-requires-readonly-source';
  END IF;
END $$;
SELECT json_build_object(
  'liveRuns', (SELECT count(*) FROM runs WHERE status IN ('queued','starting','running','blocked')),
  'pendingMessages', (SELECT count(*) FROM messages WHERE routed_at IS NULL),
  'pendingDeliveries', (SELECT count(*) FROM webhook_deliveries WHERE status='pending'),
  'busyDesigns', (SELECT count(*) FROM agent_designs WHERE busy_token IS NOT NULL OR validation_pending),
  'dbosStatuses', (SELECT coalesce(json_agg(s ORDER BY s.status),'[]'::json)
     FROM (SELECT status,count(*) AS count FROM dbos.workflow_status GROUP BY status) s)
);
-- sandboxWriters NO se inventa como cero en SQL. Añadir el conteo de contenedores activos
-- de los filtros agents.instance=dev|prod y contrastar volúmenes montados/escritores externos.
-- Si falta ese contador (o cualquiera de los anteriores), drained() devuelve false.

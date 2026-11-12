-- Tarjeta simulada (Angel 11-nov-2026): with Pagos simulados, the card the agent has assigned (and the store
-- shows as saved): brand, its last four digits, expiry and holder. Null: Visa 4242, 08/29, its owner's name.
-- Its full number is a test one, made from these (simulated-card.ts); nothing of a real card goes here.
alter table agents add column simulated_card jsonb;

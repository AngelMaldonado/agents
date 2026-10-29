-- Messages sent while the agent works wait in a queue the owner can see, send now or remove.
-- queued: held for its run until the agent finishes its turn; steer: sent at once, mid-turn.
alter table messages drop constraint messages_routed_as_check;
alter table messages add constraint messages_routed_as_check check (routed_as in ('new_run', 'queued_with', 'follow_up', 'unblock', 'queued', 'steer'));

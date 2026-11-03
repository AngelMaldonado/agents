-- The sandbox image follows the release (AGENTS_SANDBOX_IMAGE) unless an admin sets another on purpose.
-- Until now every save of Administración stored the image of that day (the form always sends it), so a
-- new release's sandbox was never used: that stored copy goes. An admin who wants a different one sets it
-- again; saving now stores it only when it differs from the release's.
update settings set value = value - 'sandboxImage' where key = 'settings';

-- Which game a server runs. Everything above internal/game resolves a row
-- through its registered game.Definition — how to reach it, which Steam app
-- to update, how to spell a player id, which dashboard views it can fill.
--
-- Defaulting to 'palworld' is what makes this migration a no-op for existing
-- installs: every row palcon has ever written was a Palworld server, and
-- game.Get treats an empty value as the default too, so a row that somehow
-- misses the default still resolves.
ALTER TABLE servers ADD COLUMN game TEXT NOT NULL DEFAULT 'palworld';

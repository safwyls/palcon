-- Phase 5: optional path to the server's save directory (the folder holding
-- Level.sav), bind-mounted read-only into the palcon container. Empty means
-- the Pal viewer is not configured for this server.
ALTER TABLE servers ADD COLUMN save_path TEXT NOT NULL DEFAULT '';

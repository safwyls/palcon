-- Multi-user access with scoped privileges, and per-server container control.
--
-- Permissions are a comma-separated list of grant keys rather than a join
-- table: the set is small and fixed, always read whole, and this keeps a
-- user's rights visible in a single row.
--
-- 'admin' in role is the escape hatch that implies every permission plus
-- user and server administration; everyone else gets exactly what's listed.
ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- The Docker container this server runs in, so Palcon can start/stop it via
-- a scoped socket proxy. Empty means power control isn't configured.
ALTER TABLE servers ADD COLUMN container_name TEXT NOT NULL DEFAULT '';

-- Existing installs have exactly one bootstrapped admin; make that explicit
-- rather than relying on the column default for rows created before this.
UPDATE users SET role = 'admin' WHERE role IS NULL OR role = '';

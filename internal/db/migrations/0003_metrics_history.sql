-- Performance history for the dashboard charts. 0001 created this table for
-- player counts alone ("phase 4: periodic server snapshots ... for charts");
-- these columns carry the rest of what /v1/api/metrics reports.
--
-- Nullable on purpose: a sample is only as complete as the reading that
-- produced it, and RCON-only servers report no metrics at all.
ALTER TABLE server_metrics ADD COLUMN server_fps REAL;
ALTER TABLE server_metrics ADD COLUMN frame_time REAL;
ALTER TABLE server_metrics ADD COLUMN max_players INTEGER;

-- player_count was NOT NULL with no default, which blocks inserting a sample
-- where only performance figures came back. SQLite can't relax a column
-- constraint in place, so the table is rebuilt.
CREATE TABLE server_metrics_new (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL DEFAULT (datetime('now')),
    player_count INTEGER,
    max_players  INTEGER,
    server_fps   REAL,
    frame_time   REAL
);
INSERT INTO server_metrics_new (id, server_id, ts, player_count, max_players, server_fps, frame_time)
    SELECT id, server_id, ts, player_count, max_players, server_fps, frame_time FROM server_metrics;
DROP TABLE server_metrics;
ALTER TABLE server_metrics_new RENAME TO server_metrics;

CREATE INDEX idx_server_metrics_server_ts ON server_metrics(server_id, ts);

CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'admin',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE servers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    host              TEXT NOT NULL,
    rcon_port         INTEGER NOT NULL DEFAULT 25575,
    rcon_password_enc TEXT NOT NULL DEFAULT '',
    rest_port         INTEGER NOT NULL DEFAULT 8212,
    rest_password_enc TEXT NOT NULL DEFAULT '',
    use_rest          INTEGER NOT NULL DEFAULT 1,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 2: scheduled tasks (cron-based restarts, broadcasts, backups).
CREATE TABLE scheduled_tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    cron_expr  TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 4: player session/playtime history, built from polling diffs.
CREATE TABLE player_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    player_uid  TEXT NOT NULL,
    player_name TEXT NOT NULL,
    joined_at   TEXT NOT NULL,
    left_at     TEXT
);

-- Phase 4: periodic server snapshots (player count etc.) for charts.
CREATE TABLE server_metrics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL DEFAULT (datetime('now')),
    player_count INTEGER NOT NULL
);

-- Phase 3: Discord (or other) webhook notification rules per event type.
CREATE TABLE notification_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1
);

-- Audit trail that phase 3 notifications and phase 4 metrics dispatch off of.
CREATE TABLE event_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_player_sessions_server ON player_sessions(server_id);
CREATE INDEX idx_server_metrics_server_ts ON server_metrics(server_id, ts);
CREATE INDEX idx_event_log_server_created ON event_log(server_id, created_at);

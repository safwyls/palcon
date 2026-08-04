package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PlayerEvent is one observed join or leave, at the collector's sampling
// granularity (~30s).
type PlayerEvent struct {
	ID       int64     `json:"id"`
	ServerID int64     `json:"-"`
	TS       time.Time `json:"ts"`
	UserID   string    `json:"userId"`
	Name     string    `json:"name"`
	Event    string    `json:"event"`
}

// InsertPlayerEvent records one observed transition. playerUID is the in-game
// uid in the dashed form save files use (see Server.CanonicalUID), and may be
// empty — sessions closed on behalf of a previous run only know who the
// events table remembered.
func (s *Store) InsertPlayerEvent(ctx context.Context, serverID int64, at time.Time, userID, playerUID, name, event string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO player_events (server_id, ts, user_id, player_uid, name, event) VALUES (?, ?, ?, ?, ?, ?)`,
		serverID, at.UTC().Format(time.RFC3339), userID, playerUID, name, event)
	return err
}

// ListPlayerEvents returns events since the cutoff, newest first.
func (s *Store) ListPlayerEvents(ctx context.Context, serverID int64, since time.Time) ([]PlayerEvent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, server_id, ts, user_id, name, event FROM player_events
		WHERE server_id = ? AND ts >= ? ORDER BY ts DESC, id DESC`,
		serverID, since.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []PlayerEvent{}
	for rows.Next() {
		var (
			e  PlayerEvent
			ts string
		)
		if err := rows.Scan(&e.ID, &e.ServerID, &ts, &e.UserID, &e.Name, &e.Event); err != nil {
			return nil, err
		}
		e.TS, _ = time.Parse(time.RFC3339, ts)
		out = append(out, e)
	}
	return out, rows.Err()
}

// OpenSession is a join with no matching leave — a player the events table
// still believes is on the server.
type OpenSession struct {
	UserID    string
	PlayerUID string
	Name      string
	Since     time.Time
}

// OpenSessions returns the players whose most recent event is a join.
// After a clean run that is exactly who is online; after palcon was killed
// it also includes everyone whose leave was never observed.
func (s *Store) OpenSessions(ctx context.Context, serverID int64) ([]OpenSession, error) {
	// Newest-per-player by id rather than ts: events land in observation
	// order, and ts alone can't break the tie between a leave and a rejoin
	// inside the same second.
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.user_id, e.player_uid, e.name, e.ts FROM player_events e
		JOIN (
			SELECT user_id, MAX(id) AS id FROM player_events WHERE server_id = ?
			GROUP BY user_id
		) newest ON newest.id = e.id
		WHERE e.event = 'join'`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []OpenSession{}
	for rows.Next() {
		var (
			o  OpenSession
			ts string
		)
		if err := rows.Scan(&o.UserID, &o.PlayerUID, &o.Name, &ts); err != nil {
			return nil, err
		}
		o.Since, _ = time.Parse(time.RFC3339, ts)
		out = append(out, o)
	}
	return out, rows.Err()
}

// LastSeen is when the collector last watched each player, keyed by in-game
// player uid in the dashed form save files use.
//
// This exists because the saves cannot answer it. A player save's
// LastOnlineDateTime is written at login and never updated, so reading it as
// "last seen" reports when someone arrived, short by however long they then
// stayed. Palcon's own observations are the only record of when a player
// actually went away.
//
// A player whose newest event is a join is still on the server as far as the
// events table knows, so their last-seen is the collector's own heartbeat —
// the last moment palcon can honestly claim to have watched them, which after
// a crash stops advancing instead of drifting into the present.
//
// Rows predating the player_uid column carry no uid and are skipped: their
// player cannot be identified, and guessing by name would credit a rename or
// a shared display name to the wrong person.
func (s *Store) LastSeen(ctx context.Context, serverID int64) (map[string]time.Time, error) {
	watch, err := s.LastWatch(ctx, serverID)
	if err != nil {
		return nil, err
	}
	// Newest-per-player by id, matching OpenSessions: events land in
	// observation order, and ts alone can't break the tie between a leave
	// and a rejoin inside the same second.
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.player_uid, e.ts, e.event FROM player_events e
		JOIN (
			SELECT player_uid, MAX(id) AS id FROM player_events
			WHERE server_id = ? AND player_uid <> ''
			GROUP BY player_uid
		) newest ON newest.id = e.id`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]time.Time{}
	for rows.Next() {
		var uid, ts, event string
		if err := rows.Scan(&uid, &ts, &event); err != nil {
			return nil, err
		}
		at, err := time.Parse(time.RFC3339, ts)
		if err != nil {
			continue
		}
		if event == "join" {
			// Never claim to have seen them before they arrived: a heartbeat
			// older than the join means palcon has not looked since.
			if at.Before(watch) {
				at = watch
			}
		}
		out[uid] = at
	}
	return out, rows.Err()
}

// TouchWatch records that the collector just observed this server's player
// list, bounding how much of an open session palcon may later claim to have
// watched if it dies before writing the matching leave.
func (s *Store) TouchWatch(ctx context.Context, serverID int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO server_watch (server_id, last_seen) VALUES (?, ?)
		ON CONFLICT(server_id) DO UPDATE SET last_seen = excluded.last_seen`,
		serverID, at.UTC().Format(time.RFC3339))
	return err
}

// LastWatch is when the collector last observed this server. The zero time
// means never: a fresh database, a server added since the last run, or the
// first start after the heartbeat existed.
func (s *Store) LastWatch(ctx context.Context, serverID int64) (time.Time, error) {
	var ts string
	err := s.db.QueryRowContext(ctx,
		`SELECT last_seen FROM server_watch WHERE server_id = ?`, serverID).Scan(&ts)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

func (s *Store) PrunePlayerEvents(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM player_events WHERE ts < ?`, before.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// AuditEntry is one management action taken through Palcon.
type AuditEntry struct {
	ID       int64     `json:"id"`
	TS       time.Time `json:"ts"`
	Username string    `json:"username"`
	ServerID int64     `json:"-"`
	Action   string    `json:"action"`
	Detail   string    `json:"detail"`
}

func (s *Store) InsertAudit(ctx context.Context, serverID int64, username, action, detail string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO audit_log (ts, username, server_id, action, detail) VALUES (?, ?, ?, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339), username, serverID, action, detail)
	return err
}

func (s *Store) ListAudit(ctx context.Context, serverID int64, limit int) ([]AuditEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, ts, username, server_id, action, detail FROM audit_log
		WHERE server_id = ? ORDER BY ts DESC, id DESC LIMIT ?`, serverID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AuditEntry{}
	for rows.Next() {
		var (
			e  AuditEntry
			ts string
		)
		if err := rows.Scan(&e.ID, &ts, &e.Username, &e.ServerID, &e.Action, &e.Detail); err != nil {
			return nil, err
		}
		e.TS, _ = time.Parse(time.RFC3339, ts)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) PruneAudit(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM audit_log WHERE ts < ?`, before.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

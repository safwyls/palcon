package store

import (
	"context"
	"database/sql"
	"time"
)

// MetricSample is one periodic reading of a server's health. Every field is
// optional because the source is: a server may answer with performance
// figures but no player list, or drop off entirely between samples.
type MetricSample struct {
	TS          time.Time
	PlayerCount *int
	MaxPlayers  *int
	ServerFPS   *float64
	FrameTime   *float64
}

// sqliteTime is the format sqlite's own datetime('now') writes, which the
// 0001 schema uses as the column default — samples we insert have to match
// it or ordering and range comparisons break down.
const sqliteTime = "2006-01-02 15:04:05"

func (s *Store) InsertMetric(ctx context.Context, serverID int64, m MetricSample) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO server_metrics (server_id, ts, player_count, max_players, server_fps, frame_time)
		VALUES (?, ?, ?, ?, ?, ?)`,
		serverID, m.TS.UTC().Format(sqliteTime), m.PlayerCount, m.MaxPlayers, m.ServerFPS, m.FrameTime)
	return err
}

// ListMetrics returns a server's samples since the given time, oldest first
// so the charts can plot straight through the slice.
func (s *Store) ListMetrics(ctx context.Context, serverID int64, since time.Time) ([]MetricSample, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT ts, player_count, max_players, server_fps, frame_time
		FROM server_metrics
		WHERE server_id = ? AND ts >= ?
		ORDER BY ts`,
		serverID, since.UTC().Format(sqliteTime))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []MetricSample
	for rows.Next() {
		var (
			ts   string
			m    MetricSample
			pc   sql.NullInt64
			mx   sql.NullInt64
			fps  sql.NullFloat64
			ftms sql.NullFloat64
		)
		if err := rows.Scan(&ts, &pc, &mx, &fps, &ftms); err != nil {
			return nil, err
		}
		parsed, err := time.ParseInLocation(sqliteTime, ts, time.UTC)
		if err != nil {
			continue // a row we can't place in time is worse than no row
		}
		m.TS = parsed
		if pc.Valid {
			v := int(pc.Int64)
			m.PlayerCount = &v
		}
		if mx.Valid {
			v := int(mx.Int64)
			m.MaxPlayers = &v
		}
		if fps.Valid {
			m.ServerFPS = &fps.Float64
		}
		if ftms.Valid {
			m.FrameTime = &ftms.Float64
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// PruneMetrics drops samples older than the cutoff, keeping the table from
// growing without bound on a long-running deployment.
func (s *Store) PruneMetrics(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM server_metrics WHERE ts < ?`, before.UTC().Format(sqliteTime))
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

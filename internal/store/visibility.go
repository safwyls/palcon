package store

import (
	"context"
	"sort"
	"strings"
)

// Views an admin can switch off per server. The keys double as the frontend's
// route names, so a disabled feature hides its nav link and refuses its data
// with the same string.
const (
	FeatureMap         = "map"
	FeaturePals        = "pals"
	FeatureInventory   = "inventory"
	FeatureStorage     = "storage"
	FeaturePaldex      = "paldex"
	FeatureGuilds      = "guilds"
	FeatureCalculators = "calculators"
)

// AllFeatures is the menu the settings UI offers, in nav order.
var AllFeatures = []string{
	FeatureMap, FeaturePals, FeatureInventory, FeatureStorage, FeaturePaldex, FeatureGuilds, FeatureCalculators,
}

// Streams a single player can be withheld from. Deliberately coarser than the
// view list: Player pals, Paldex and Calculators all read one payload, so they
// share one switch. Hiding a player from a view while another view serves the
// same bytes would be privacy theatre.
const (
	StreamPals      = "pals"
	StreamInventory = "inventory"
	StreamMap       = "map"
)

var AllStreams = []string{StreamPals, StreamInventory, StreamMap}

// encodeKeys keeps only recognised keys, so a renamed feature can't linger in
// the database as a permanent invisible hide. Sorted for a stable column value.
func encodeKeys(keys, known []string) string {
	seen := make(map[string]bool, len(keys))
	valid := make([]string, 0, len(keys))
	for _, k := range keys {
		if seen[k] {
			continue
		}
		for _, ok := range known {
			if k == ok {
				seen[k] = true
				valid = append(valid, k)
				break
			}
		}
	}
	sort.Strings(valid)
	return strings.Join(valid, ",")
}

func decodeKeys(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Hidden reports whether key appears in list.
func Hidden(list []string, key string) bool {
	for _, k := range list {
		if k == key {
			return true
		}
	}
	return false
}

// SetHidePrivateStorage switches whether the Storage view may search chests a
// player has put a password on.
func (s *Store) SetHidePrivateStorage(ctx context.Context, serverID int64, hide bool) error {
	v := 0
	if hide {
		v = 1
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE servers SET hide_private_storage = ? WHERE id = ?`, v, serverID)
	return err
}

// SetHiddenFeatures replaces the server's disabled-view list.
func (s *Store) SetHiddenFeatures(ctx context.Context, serverID int64, hidden []string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE servers SET hidden_features = ? WHERE id = ?`,
		encodeKeys(hidden, AllFeatures), serverID)
	return err
}

// PlayerVisibility maps a player uid to the streams they're withheld from.
// Players with nothing hidden are absent rather than present-and-empty.
type PlayerVisibility map[string][]string

// HiddenFor reports whether this player is withheld from the given stream.
func (v PlayerVisibility) HiddenFor(uid, stream string) bool {
	return Hidden(v[uid], stream)
}

func (s *Store) ListPlayerVisibility(ctx context.Context, serverID int64) (PlayerVisibility, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT player_uid, hidden_streams FROM player_visibility WHERE server_id = ?`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := PlayerVisibility{}
	for rows.Next() {
		var uid, hidden string
		if err := rows.Scan(&uid, &hidden); err != nil {
			return nil, err
		}
		if keys := decodeKeys(hidden); len(keys) > 0 {
			out[uid] = keys
		}
	}
	return out, rows.Err()
}

// SetPlayerVisibility replaces one player's hidden-stream list. An empty list
// deletes the row, so the table only ever holds actual opt-outs.
func (s *Store) SetPlayerVisibility(ctx context.Context, serverID int64, uid string, hidden []string) error {
	encoded := encodeKeys(hidden, AllStreams)
	if encoded == "" {
		_, err := s.db.ExecContext(ctx,
			`DELETE FROM player_visibility WHERE server_id = ? AND player_uid = ?`, serverID, uid)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO player_visibility (server_id, player_uid, hidden_streams) VALUES (?, ?, ?)
		ON CONFLICT (server_id, player_uid) DO UPDATE SET hidden_streams = excluded.hidden_streams`,
		serverID, uid, encoded)
	return err
}

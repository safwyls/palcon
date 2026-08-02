package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var ErrNotFound = errors.New("not found")

// Server is the decrypted, application-facing view of a servers row.
// RCONPassword/RESTPassword are only populated when explicitly needed
// (e.g. to build a palworld.Client) and are never serialized to the API.
type Server struct {
	ID           int64
	Name         string
	Host         string
	RCONPort     int
	RCONPassword string
	RESTPort     int
	RESTPassword string
	// GamePort is the UDP port players join on — display/provisioning
	// metadata only; palcon never speaks the game protocol.
	GamePort int
	// JoinAddress is what players outside the LAN type to connect (a public
	// hostname or IP, optionally with :port). Host is the management address
	// and is typically private, so it can't stand in. Empty = show
	// Host:GamePort.
	JoinAddress string
	UseREST     bool
	Enabled     bool
	// SavePath is an optional container-local path to the directory holding
	// the server's Level.sav (phase 5 Pal viewer), bind-mounted read-only.
	// Empty = not configured.
	SavePath string
	// ConfigPath is an optional container-local path to the directory holding
	// the server's PalWorldSettings.ini, bind-mounted read-write so the
	// settings editor can change it. Separate from SavePath so save data
	// stays read-only. Empty = settings editor off.
	ConfigPath string
	// InstallPath is an optional container-local path to the Palworld install
	// root (the directory holding steamapps/ and steam/), bind-mounted
	// read-write so the SteamCMD cache repair tool can wipe corrupted
	// manifests. Empty = repair tool off.
	InstallPath string
	// AgentURL points at the server's palagent sidecar
	// (docs/sidecar-agent.md); AgentToken is the bearer token palcon
	// presents to it, encrypted at rest like the RCON/REST passwords and
	// only populated when explicitly needed. Empty URL = no agent.
	AgentURL   string
	AgentToken string
	// ContainerName is the Docker container this server runs in, used for
	// start/stop/restart via the socket proxy. Empty = power control off.
	ContainerName string
	// Watchdog restarts the container after an unclean exit. Toggled via
	// SetWatchdog, not UpdateServer — the server-edit form doesn't carry it,
	// and a form save must never silently switch the watchdog off.
	Watchdog bool
	// PublicToken makes a read-only status page available at
	// /status/<token>; empty = off. Managed via SetPublicToken, outside
	// UpdateServer for the same reason as Watchdog.
	PublicToken string
	// Save-backup schedule: snapshot every BackupIntervalHours (0 = no
	// schedule), keeping the newest BackupKeep snapshots. Managed via
	// SetBackupSettings, outside UpdateServer like the other automations.
	BackupIntervalHours int
	BackupKeep          int
	// HiddenFeatures names the views an admin has switched off for this
	// server (store.AllFeatures). Empty = everything visible; admins see
	// hidden views anyway, so this gates what everyone else is served.
	HiddenFeatures []string
	// HidePrivateStorage keeps password-locked chests out of the Storage
	// view's index. False = searchable, which is the pre-existing behaviour.
	// Deliberately not bypassed for admins — see the 0018 migration.
	HidePrivateStorage bool
}

type serverRow struct {
	ID              int64
	Name            string
	Host            string
	RCONPort        int
	RCONPasswordEnc string
	RESTPort        int
	RESTPasswordEnc string
	GamePort        int
	JoinAddress     string
	UseREST         int
	Enabled         int
	SavePath        string
	ConfigPath      string
	InstallPath     string
	AgentURL        string
	AgentTokenEnc   string
	ContainerName   string
	Watchdog        int
	PublicToken     string
	BackupInterval  int
	BackupKeep      int
	HiddenFeatures  string
	HidePrivate     int
}

func (s *Store) decryptServer(r serverRow) (*Server, error) {
	rconPass, err := s.box.Decrypt(r.RCONPasswordEnc)
	if err != nil {
		return nil, fmt.Errorf("decrypting rcon password: %w", err)
	}
	restPass, err := s.box.Decrypt(r.RESTPasswordEnc)
	if err != nil {
		return nil, fmt.Errorf("decrypting rest password: %w", err)
	}
	agentToken, err := s.box.Decrypt(r.AgentTokenEnc)
	if err != nil {
		return nil, fmt.Errorf("decrypting agent token: %w", err)
	}
	return &Server{
		ID:                  r.ID,
		Name:                r.Name,
		Host:                r.Host,
		RCONPort:            r.RCONPort,
		RCONPassword:        rconPass,
		RESTPort:            r.RESTPort,
		RESTPassword:        restPass,
		GamePort:            r.GamePort,
		JoinAddress:         r.JoinAddress,
		UseREST:             r.UseREST != 0,
		Enabled:             r.Enabled != 0,
		SavePath:            r.SavePath,
		ConfigPath:          r.ConfigPath,
		InstallPath:         r.InstallPath,
		AgentURL:            r.AgentURL,
		AgentToken:          agentToken,
		ContainerName:       r.ContainerName,
		Watchdog:            r.Watchdog != 0,
		PublicToken:         r.PublicToken,
		BackupIntervalHours: r.BackupInterval,
		BackupKeep:          r.BackupKeep,
		HiddenFeatures:      decodeKeys(r.HiddenFeatures),
		HidePrivateStorage:  r.HidePrivate != 0,
	}, nil
}

const serverColumns = `id, name, host, rcon_port, rcon_password_enc, rest_port, rest_password_enc, game_port, join_address, use_rest, enabled, save_path, config_path, install_path, agent_url, agent_token_enc, container_name, watchdog, public_token, backup_interval_hours, backup_keep, hidden_features, hide_private_storage`

func scanServerRow(scan func(dest ...any) error) (serverRow, error) {
	var r serverRow
	err := scan(&r.ID, &r.Name, &r.Host, &r.RCONPort, &r.RCONPasswordEnc, &r.RESTPort, &r.RESTPasswordEnc, &r.GamePort, &r.JoinAddress, &r.UseREST, &r.Enabled, &r.SavePath, &r.ConfigPath, &r.InstallPath, &r.AgentURL, &r.AgentTokenEnc, &r.ContainerName, &r.Watchdog, &r.PublicToken, &r.BackupInterval, &r.BackupKeep, &r.HiddenFeatures, &r.HidePrivate)
	return r, err
}

func (s *Store) ListServers(ctx context.Context) ([]*Server, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+serverColumns+` FROM servers ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*Server
	for rows.Next() {
		r, err := scanServerRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		srv, err := s.decryptServer(r)
		if err != nil {
			return nil, err
		}
		out = append(out, srv)
	}
	return out, rows.Err()
}

func (s *Store) GetServer(ctx context.Context, id int64) (*Server, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+serverColumns+` FROM servers WHERE id = ?`, id)
	r, err := scanServerRow(row.Scan)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.decryptServer(r)
}

// CreateServer inserts a new server, encrypting the given plaintext
// passwords before they touch disk.
func (s *Store) CreateServer(ctx context.Context, srv *Server) (int64, error) {
	rconEnc, err := s.box.Encrypt(srv.RCONPassword)
	if err != nil {
		return 0, err
	}
	restEnc, err := s.box.Encrypt(srv.RESTPassword)
	if err != nil {
		return 0, err
	}
	agentEnc, err := s.box.Encrypt(srv.AgentToken)
	if err != nil {
		return 0, err
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO servers (name, host, rcon_port, rcon_password_enc, rest_port, rest_password_enc, game_port, join_address, use_rest, enabled, save_path, config_path, install_path, agent_url, agent_token_enc, container_name)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		srv.Name, srv.Host, srv.RCONPort, rconEnc, srv.RESTPort, restEnc, normalizeGamePort(srv.GamePort), strings.TrimSpace(srv.JoinAddress), boolToInt(srv.UseREST), boolToInt(srv.Enabled), srv.SavePath, srv.ConfigPath, srv.InstallPath, srv.AgentURL, agentEnc, srv.ContainerName)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateServer updates fields on an existing server. Passwords are only
// re-encrypted and overwritten when non-empty, so callers can update other
// fields without resending credentials.
func (s *Store) UpdateServer(ctx context.Context, srv *Server) error {
	existing, err := s.GetServer(ctx, srv.ID)
	if err != nil {
		return err
	}
	if srv.RCONPassword == "" {
		srv.RCONPassword = existing.RCONPassword
	}
	if srv.RESTPassword == "" {
		srv.RESTPassword = existing.RESTPassword
	}
	if srv.AgentToken == "" {
		srv.AgentToken = existing.AgentToken
	}

	rconEnc, err := s.box.Encrypt(srv.RCONPassword)
	if err != nil {
		return err
	}
	restEnc, err := s.box.Encrypt(srv.RESTPassword)
	if err != nil {
		return err
	}
	agentEnc, err := s.box.Encrypt(srv.AgentToken)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		UPDATE servers
		SET name = ?, host = ?, rcon_port = ?, rcon_password_enc = ?,
		    rest_port = ?, rest_password_enc = ?, game_port = ?, join_address = ?, use_rest = ?, enabled = ?,
		    save_path = ?, config_path = ?, install_path = ?,
		    agent_url = ?, agent_token_enc = ?, container_name = ?
		WHERE id = ?`,
		srv.Name, srv.Host, srv.RCONPort, rconEnc, srv.RESTPort, restEnc,
		normalizeGamePort(srv.GamePort), strings.TrimSpace(srv.JoinAddress), boolToInt(srv.UseREST), boolToInt(srv.Enabled), srv.SavePath, srv.ConfigPath, srv.InstallPath,
		srv.AgentURL, agentEnc, srv.ContainerName, srv.ID)
	return err
}

// SetWatchdog flips the crash watchdog on its own — see the field comment
// for why this isn't part of UpdateServer.
func (s *Store) SetWatchdog(ctx context.Context, id int64, enabled bool) error {
	res, err := s.db.ExecContext(ctx, `UPDATE servers SET watchdog = ? WHERE id = ?`, boolToInt(enabled), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

// SetPublicToken sets or clears the public status token, outside
// UpdateServer for the same never-wiped-by-a-form-save reason as Watchdog.
func (s *Store) SetPublicToken(ctx context.Context, id int64, token string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE servers SET public_token = ? WHERE id = ?`, token, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

// GetServerByPublicToken resolves a public status token. An empty token
// never matches — it's the "feature off" value on every row.
func (s *Store) GetServerByPublicToken(ctx context.Context, token string) (*Server, error) {
	if token == "" {
		return nil, ErrNotFound
	}
	row := s.db.QueryRowContext(ctx, `SELECT `+serverColumns+` FROM servers WHERE public_token = ?`, token)
	r, err := scanServerRow(row.Scan)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return s.decryptServer(r)
}

// SetBackupSettings updates the backup schedule, outside UpdateServer like
// the other automation toggles.
func (s *Store) SetBackupSettings(ctx context.Context, id int64, intervalHours, keep int) error {
	res, err := s.db.ExecContext(ctx, `UPDATE servers SET backup_interval_hours = ?, backup_keep = ? WHERE id = ?`,
		intervalHours, keep, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) DeleteServer(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, id)
	return err
}

// normalizeGamePort keeps a zero from an old client meaning "default"
// rather than storing an unjoinable port.
func normalizeGamePort(p int) int {
	if p < 1 || p > 65535 {
		return 8211
	}
	return p
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

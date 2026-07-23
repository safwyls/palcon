package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	UseREST      bool
	Enabled      bool
	// SavePath is an optional container-local path to the directory holding
	// the server's Level.sav (phase 5 Pal viewer). Empty = not configured.
	SavePath string
}

type serverRow struct {
	ID              int64
	Name            string
	Host            string
	RCONPort        int
	RCONPasswordEnc string
	RESTPort        int
	RESTPasswordEnc string
	UseREST         int
	Enabled         int
	SavePath        string
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
	return &Server{
		ID:           r.ID,
		Name:         r.Name,
		Host:         r.Host,
		RCONPort:     r.RCONPort,
		RCONPassword: rconPass,
		RESTPort:     r.RESTPort,
		RESTPassword: restPass,
		UseREST:      r.UseREST != 0,
		Enabled:      r.Enabled != 0,
		SavePath:     r.SavePath,
	}, nil
}

const serverColumns = `id, name, host, rcon_port, rcon_password_enc, rest_port, rest_password_enc, use_rest, enabled, save_path`

func scanServerRow(scan func(dest ...any) error) (serverRow, error) {
	var r serverRow
	err := scan(&r.ID, &r.Name, &r.Host, &r.RCONPort, &r.RCONPasswordEnc, &r.RESTPort, &r.RESTPasswordEnc, &r.UseREST, &r.Enabled, &r.SavePath)
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
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO servers (name, host, rcon_port, rcon_password_enc, rest_port, rest_password_enc, use_rest, enabled, save_path)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		srv.Name, srv.Host, srv.RCONPort, rconEnc, srv.RESTPort, restEnc, boolToInt(srv.UseREST), boolToInt(srv.Enabled), srv.SavePath)
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

	rconEnc, err := s.box.Encrypt(srv.RCONPassword)
	if err != nil {
		return err
	}
	restEnc, err := s.box.Encrypt(srv.RESTPassword)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		UPDATE servers
		SET name = ?, host = ?, rcon_port = ?, rcon_password_enc = ?,
		    rest_port = ?, rest_password_enc = ?, use_rest = ?, enabled = ?,
		    save_path = ?
		WHERE id = ?`,
		srv.Name, srv.Host, srv.RCONPort, rconEnc, srv.RESTPort, restEnc,
		boolToInt(srv.UseREST), boolToInt(srv.Enabled), srv.SavePath, srv.ID)
	return err
}

func (s *Store) DeleteServer(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM servers WHERE id = ?`, id)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

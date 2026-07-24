package store

import (
	"context"
	"database/sql"
	"strings"
)

// Permission keys. Viewing is deliberately not among them: any signed-in
// user can read dashboards, the map and save data. These gate the actions
// that change something.
const (
	// PermPower starts, stops and restarts the server's container.
	PermPower = "power"
	// PermBroadcast sends in-game messages.
	PermBroadcast = "broadcast"
	// PermSave triggers a world save.
	PermSave = "save"
	// PermModerate kicks, bans and unbans players.
	PermModerate = "moderate"
	// PermShutdown is the in-game timed shutdown, kept separate from
	// PermPower so someone can be trusted to restart the container without
	// also being able to boot everyone mid-session.
	PermShutdown = "shutdown"
)

// AllPermissions is the set an admin implicitly holds, and the menu the
// user-management UI offers.
var AllPermissions = []string{PermPower, PermBroadcast, PermSave, PermModerate, PermShutdown}

const RoleAdmin = "admin"

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	Role         string
	Permissions  []string
	Disabled     bool
}

func (u *User) IsAdmin() bool { return u.Role == RoleAdmin }

// Can reports whether the user may perform an action. Admins can do
// everything, which keeps "who can repair a broken grant" from depending
// on the grants themselves.
func (u *User) Can(permission string) bool {
	if u.Disabled {
		return false
	}
	if u.IsAdmin() {
		return true
	}
	for _, p := range u.Permissions {
		if p == permission {
			return true
		}
	}
	return false
}

func encodePermissions(perms []string) string {
	valid := make([]string, 0, len(perms))
	for _, p := range perms {
		for _, known := range AllPermissions {
			if p == known {
				valid = append(valid, p)
				break
			}
		}
	}
	return strings.Join(valid, ",")
}

func decodePermissions(s string) []string {
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

const userColumns = `id, username, password_hash, role, permissions, disabled`

func scanUser(scan func(...any) error) (*User, error) {
	var u User
	var perms string
	var disabled int
	if err := scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &perms, &disabled); err != nil {
		return nil, err
	}
	u.Permissions = decodePermissions(perms)
	u.Disabled = disabled != 0
	return &u, nil
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE username = ?`, username)
	u, err := scanUser(row.Scan)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return u, err
}

func (s *Store) GetUser(ctx context.Context, id int64) (*User, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users WHERE id = ?`, id)
	u, err := scanUser(row.Scan)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	return u, err
}

func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*User
	for rows.Next() {
		u, err := scanUser(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) CreateUser(ctx context.Context, username, passwordHash, role string, perms []string) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)`,
		username, passwordHash, role, encodePermissions(perms))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateUser changes role, permissions and enabled state. Passwords are
// handled separately so a permission edit can't silently reset one.
func (s *Store) UpdateUser(ctx context.Context, id int64, role string, perms []string, disabled bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET role = ?, permissions = ?, disabled = ? WHERE id = ?`,
		role, encodePermissions(perms), boolToInt(disabled), id)
	return err
}

func (s *Store) SetUserPassword(ctx context.Context, id int64, passwordHash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, id)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	return err
}

// CountAdmins backs the guard against removing or demoting the last admin,
// which would leave the instance unmanageable.
func (s *Store) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM users WHERE role = ? AND disabled = 0`, RoleAdmin).Scan(&n)
	return n, err
}

package store

import (
	"context"
	"database/sql"
)

type User struct {
	ID           int64
	Username     string
	PasswordHash string
	Role         string
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id, username, password_hash, role FROM users WHERE username = ?`, username)
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) CreateUser(ctx context.Context, username, passwordHash, role string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, username, passwordHash, role)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

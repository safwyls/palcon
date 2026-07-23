// Package db opens the sqlite database and applies migrations on startup.
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open opens (creating if necessary) the sqlite database at path and
// applies any migrations that haven't run yet.
func Open(path string) (*sql.DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	sqlDB.SetMaxOpenConns(1) // sqlite: avoid concurrent-write "database is locked" errors

	if err := migrate(sqlDB); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("running migrations: %w", err)
	}
	return sqlDB, nil
}

func migrate(sqlDB *sql.DB) error {
	if _, err := sqlDB.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		filename   TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`); err != nil {
		return err
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var already string
		err := sqlDB.QueryRow(`SELECT filename FROM schema_migrations WHERE filename = ?`, name).Scan(&already)
		if err == nil {
			continue // already applied
		}
		if err != sql.ErrNoRows {
			return err
		}

		contents, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}

		tx, err := sqlDB.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(contents)); err != nil {
			tx.Rollback()
			return fmt.Errorf("applying %s: %w", name, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (filename) VALUES (?)`, name); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

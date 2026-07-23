// Package store is the data access layer: sqlite-backed persistence for
// servers and users, with RCON/REST passwords encrypted at rest.
package store

import (
	"database/sql"

	"github.com/safwyls/palcon/internal/crypto"
)

type Store struct {
	db  *sql.DB
	box *crypto.Box
}

func New(db *sql.DB, box *crypto.Box) *Store {
	return &Store{db: db, box: box}
}

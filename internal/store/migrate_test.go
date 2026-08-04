package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/safwyls/palcon/internal/crypto"
	"github.com/safwyls/palcon/internal/db"
	"github.com/safwyls/palcon/internal/game"

	// Registers the games, so the definition lookups below resolve for real
	// instead of skipping.
	_ "github.com/safwyls/palcon/internal/games"
)

// Existing installs upgrade in place, and a server row that predates the game
// column has to keep working. The column is what every request resolves a row
// through, so if the backfill were wrong the failure would be total and would
// only show up on someone else's database.
func TestUpgradeBackfillsGameOnExistingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	sqlDB, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	box, err := crypto.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	st := New(sqlDB, box)

	id, err := st.CreateServer(context.Background(), &Server{Name: "old", Host: "10.0.0.5", RCONPort: 25575})
	if err != nil {
		t.Fatal(err)
	}

	// Rewind to the pre-migration shape: drop the column and forget that the
	// migration ran, so reopening replays it against a populated table.
	if _, err := sqlDB.Exec(`ALTER TABLE servers DROP COLUMN game`); err != nil {
		t.Fatalf("simulating the old schema: %v", err)
	}
	if _, err := sqlDB.Exec(`DELETE FROM schema_migrations WHERE filename = '0019_game.sql'`); err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := db.Open(path)
	if err != nil {
		t.Fatalf("re-running the migration over existing rows: %v", err)
	}
	defer upgraded.Close()

	srv, err := New(upgraded, box).GetServer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if srv.Game != game.DefaultID {
		t.Errorf("upgraded row game = %q, want %q", srv.Game, game.DefaultID)
	}
	if srv.Name != "old" || srv.Host != "10.0.0.5" {
		t.Errorf("upgrade disturbed the row: %+v", srv)
	}
}

// An empty game must resolve rather than fail: game.Get treats it as the
// default, which is the second line of defence behind the column default.
func TestEmptyGameResolvesToDefault(t *testing.T) {
	srv := &Server{}
	def, ok := srv.Definition()
	if !ok {
		t.Fatal("empty game did not resolve to the default")
	}
	if def.ID != game.DefaultID {
		t.Errorf("empty game resolved to %q, want %q", def.ID, game.DefaultID)
	}
}

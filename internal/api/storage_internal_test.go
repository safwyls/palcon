package api

import (
	"testing"

	"github.com/safwyls/palcon/internal/palsave"
)

// TestStorageForWithholdsWorldLoot pins the world-loot toggle as a server-side
// filter.
//
// This is the difference between a spoiler someone opted into and one the page
// received and chose not to draw: the world's treasure boxes are most of the
// payload, and their locations are the whole game of finding them. A future
// refactor that moves the filtering into the frontend would still look right on
// screen and would be wrong.
func TestStorageForWithholdsWorldLoot(t *testing.T) {
	all := []palsave.StorageContainer{
		{ID: "chest", Kind: palsave.KindBase},
		{ID: "treasure", Kind: palsave.KindWorld},
		{ID: "orphan", Kind: palsave.KindUnplaced},
		{ID: "treasure2", Kind: palsave.KindWorld},
	}

	got := storageFor(all, false, true)
	if len(got) != 2 {
		t.Fatalf("without world: got %d containers, want 2: %+v", len(got), got)
	}
	for _, c := range got {
		if c.Kind == palsave.KindWorld {
			t.Fatalf("world loot served without being asked for: %+v", c)
		}
	}

	// Asked for, it all comes through — including the base storage, since the
	// toggle widens the search rather than switching to a different one.
	if got := storageFor(all, true, true); len(got) != 4 {
		t.Fatalf("with world: got %d containers, want 4: %+v", len(got), got)
	}

	// A save with nothing in it serves an empty list, not null: the page reads
	// containers.length, and a null there is a crash rather than an empty view.
	if got := storageFor(nil, true, true); got == nil || len(got) != 0 {
		t.Fatalf("empty save: got %+v, want an empty non-nil slice", got)
	}
}

// TestStorageForWithholdsPrivateChests pins the admin switch that keeps
// password-locked chests out of the index.
//
// A password on a chest is the clearest statement a player can make that its
// contents are theirs, so when an admin honours that the contents must not be
// in the payload at all — not merely filtered by the page that received them.
func TestStorageForWithholdsPrivateChests(t *testing.T) {
	all := []palsave.StorageContainer{
		{ID: "open", Kind: palsave.KindBase},
		{ID: "locked", Kind: palsave.KindBase, Private: true},
		{ID: "treasure", Kind: palsave.KindWorld},
		// A locked chest out in the world would have to clear both switches.
		{ID: "locked-world", Kind: palsave.KindWorld, Private: true},
	}

	got := storageFor(all, true, false)
	if len(got) != 2 {
		t.Fatalf("private withheld: got %d containers, want 2: %+v", len(got), got)
	}
	for _, c := range got {
		if c.Private {
			t.Fatalf("locked chest served while the switch was off: %+v", c)
		}
	}

	// Neither switch stands in for the other: allowing private chests must not
	// smuggle world loot past a reader who didn't ask for it, and vice versa.
	if got := storageFor(all, false, true); len(got) != 2 {
		t.Fatalf("private on, world off: got %d, want 2 (the two base chests): %+v", len(got), got)
	}
	if got := storageFor(all, false, false); len(got) != 1 || got[0].ID != "open" {
		t.Fatalf("both off: got %+v, want just the open base chest", got)
	}
	if got := storageFor(all, true, true); len(got) != 4 {
		t.Fatalf("both on: got %d, want all 4: %+v", len(got), got)
	}
}

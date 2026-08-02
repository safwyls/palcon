package store

import (
	"context"
	"reflect"
	"testing"
)

func TestEncodeKeysDropsUnknownAndDuplicates(t *testing.T) {
	// A renamed or removed feature must not survive in the column: it would be
	// a hide nothing in the UI can see, and nothing can therefore undo.
	got := encodeKeys([]string{FeaturePals, "not-a-feature", FeaturePals, FeatureMap}, AllFeatures)
	if got != "map,pals" {
		t.Fatalf("encodeKeys = %q, want %q", got, "map,pals")
	}
	if got := encodeKeys(nil, AllFeatures); got != "" {
		t.Fatalf("encodeKeys(nil) = %q, want empty", got)
	}
	// Streams are a different vocabulary; a feature key isn't a valid stream.
	if got := encodeKeys([]string{FeaturePaldex}, AllStreams); got != "" {
		t.Fatalf("paldex is not a stream, got %q", got)
	}
}

func TestHiddenFeaturesRoundTrip(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()

	id, err := s.CreateServer(ctx, &Server{Name: "one", Host: "10.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}

	// A fresh server hides nothing — existing installs must not change
	// behaviour when the migration lands.
	srv, err := s.GetServer(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(srv.HiddenFeatures) != 0 {
		t.Fatalf("new server hides %v, want nothing", srv.HiddenFeatures)
	}

	if err := s.SetHiddenFeatures(ctx, id, []string{FeatureInventory, FeatureMap}); err != nil {
		t.Fatal(err)
	}
	srv, err = s.GetServer(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(srv.HiddenFeatures, []string{FeatureInventory, FeatureMap}) {
		t.Fatalf("hidden = %v", srv.HiddenFeatures)
	}

	// Editing a server through the normal path must not clear the hides —
	// they're set by their own endpoint, like the watchdog and backup fields.
	srv.Name = "renamed"
	if err := s.UpdateServer(ctx, srv); err != nil {
		t.Fatal(err)
	}
	srv, err = s.GetServer(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(srv.HiddenFeatures) != 2 {
		t.Fatalf("UpdateServer cleared visibility: %v", srv.HiddenFeatures)
	}
}

func TestPlayerVisibility(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()

	id, err := s.CreateServer(ctx, &Server{Name: "one", Host: "10.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	const uid = "11111111-1111-1111-1111-111111111111"

	if err := s.SetPlayerVisibility(ctx, id, uid, []string{StreamInventory}); err != nil {
		t.Fatal(err)
	}
	v, err := s.ListPlayerVisibility(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !v.HiddenFor(uid, StreamInventory) {
		t.Fatalf("inventory should be hidden: %v", v)
	}
	if v.HiddenFor(uid, StreamPals) || v.HiddenFor("someone-else", StreamInventory) {
		t.Fatalf("hid too much: %v", v)
	}

	// Clearing deletes the row rather than storing an empty one, so the table
	// only ever holds real opt-outs.
	if err := s.SetPlayerVisibility(ctx, id, uid, nil); err != nil {
		t.Fatal(err)
	}
	v, err = s.ListPlayerVisibility(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(v) != 0 {
		t.Fatalf("clearing left %v", v)
	}
}

func TestHidePrivateStorageRoundTrip(t *testing.T) {
	s, _ := newTestStore(t)
	ctx := context.Background()

	id, err := s.CreateServer(ctx, &Server{Name: "one", Host: "10.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}

	// Default off, like every other switch here: the migration must not change
	// what an existing server serves.
	srv, err := s.GetServer(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if srv.HidePrivateStorage {
		t.Fatal("a fresh server should search locked chests")
	}

	if err := s.SetHidePrivateStorage(ctx, id, true); err != nil {
		t.Fatal(err)
	}
	if srv, err = s.GetServer(ctx, id); err != nil {
		t.Fatal(err)
	} else if !srv.HidePrivateStorage {
		t.Fatal("switch did not persist")
	}

	// ListServers scans the same columns by a different path, so a column
	// added to one and not the other reads as a silently-reset switch.
	all, err := s.ListServers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || !all[0].HidePrivateStorage {
		t.Fatalf("ListServers lost the switch: %+v", all)
	}

	if err := s.SetHidePrivateStorage(ctx, id, false); err != nil {
		t.Fatal(err)
	}
	if srv, err = s.GetServer(ctx, id); err != nil {
		t.Fatal(err)
	} else if srv.HidePrivateStorage {
		t.Fatal("switch did not clear")
	}
}

package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/store"
)

// A save caught mid-write would archive fine and only reveal itself on
// restore day, so the magic is checked before anything is written.
func TestVerifySavMagic(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, head []byte) string {
		t.Helper()
		path := filepath.Join(dir, name)
		body := append(head, make([]byte, 64)...)
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	header := func(magic string, at int) []byte {
		h := make([]byte, 24)
		copy(h[at:], magic)
		return h
	}

	t.Run("accepts the two plain containers", func(t *testing.T) {
		for _, magic := range []string{"PlZ", "PlM"} {
			if err := verifySavMagic(write("ok_"+magic, header(magic, 8))); err != nil {
				t.Errorf("%s should be accepted: %v", magic, err)
			}
		}
	})

	t.Run("accepts an Xbox chunked container", func(t *testing.T) {
		// The real header sits 12 bytes further in.
		h := header("CNK", 8)
		copy(h[20:], "PlZ")
		if err := verifySavMagic(write("cnk", h)); err != nil {
			t.Errorf("chunked container should be accepted: %v", err)
		}
	})

	t.Run("rejects a chunked container with junk inside", func(t *testing.T) {
		h := header("CNK", 8)
		copy(h[20:], "XXX")
		if err := verifySavMagic(write("cnk_bad", h)); err == nil {
			t.Error("a chunked container with no save inside was accepted")
		}
	})

	t.Run("rejects unknown magic", func(t *testing.T) {
		if err := verifySavMagic(write("junk", header("ZIP", 8))); err == nil {
			t.Error("junk magic was accepted")
		}
	})

	t.Run("rejects a file too short to have a header", func(t *testing.T) {
		short := filepath.Join(dir, "short")
		if err := os.WriteFile(short, []byte("tiny"), 0o644); err != nil {
			t.Fatal(err)
		}
		err := verifySavMagic(short)
		if err == nil {
			t.Fatal("a truncated save was accepted")
		}
		if !strings.Contains(err.Error(), "too short") {
			t.Errorf("unhelpful error: %v", err)
		}
	})

	t.Run("reports a missing file", func(t *testing.T) {
		if err := verifySavMagic(filepath.Join(dir, "nope")); err == nil {
			t.Error("a missing save was accepted")
		}
	})
}

// levelSavPath accepts either the save directory or the Level.sav inside it,
// since both spellings turn up in configured paths.
func TestLevelSavPath(t *testing.T) {
	if got := levelSavPath("/saves/world"); got != filepath.Join("/saves/world", "Level.sav") {
		t.Errorf("directory form = %q", got)
	}
	for _, direct := range []string{"/saves/world/Level.sav", "/saves/world/level.sav", "/saves/world/LEVEL.SAV"} {
		if got := levelSavPath(direct); got != direct {
			t.Errorf("%q should be used as-is, got %q", direct, got)
		}
	}
}

func TestBackupNowWithoutASaveConfigured(t *testing.T) {
	r := testRunner(t)
	_, err := r.BackupNow(context.Background(), &store.Server{ID: 1, Name: "bare"})
	if err == nil {
		t.Fatal("backing up a server with no save reported success")
	}
	if !strings.Contains(err.Error(), "no save path") {
		t.Errorf("unhelpful error: %v", err)
	}
}

// A second backup while one is running is refused rather than queued or run
// concurrently — two writers on one archive directory is not worth the risk.
func TestBackupNowRefusesAConcurrentRun(t *testing.T) {
	r := testRunner(t)
	srv := srvWith(fakeSave(t))

	r.mu.Lock()
	r.running[srv.ID] = true
	r.mu.Unlock()

	if _, err := r.BackupNow(context.Background(), srv); err != ErrBusy {
		t.Errorf("concurrent backup: %v, want ErrBusy", err)
	}

	// The flag is the only thing standing in the way; clearing it lets the
	// next call through.
	r.mu.Lock()
	delete(r.running, srv.ID)
	r.mu.Unlock()
	if _, err := r.BackupNow(context.Background(), srv); err != nil {
		t.Errorf("backup after the flag cleared: %v", err)
	}
}

func TestBackupNowRejectsAMissingSaveDirectory(t *testing.T) {
	r := testRunner(t)
	srv := srvWith(filepath.Join(t.TempDir(), "does-not-exist"))

	if _, err := r.BackupNow(context.Background(), srv); err == nil {
		t.Error("backing up a missing save directory reported success")
	}
	// The busy flag must not be left set behind a failure, or the server
	// can never be backed up again without a restart.
	if r.Running(srv.ID) {
		t.Error("the running flag survived a failed backup")
	}
}

func TestListAndPathOnAServerWithNoBackups(t *testing.T) {
	r := testRunner(t)

	snaps, err := r.List(99)
	if err != nil {
		t.Fatalf("listing a server with no backups: %v", err)
	}
	if len(snaps) != 0 {
		t.Errorf("snapshots = %d, want none", len(snaps))
	}
	if _, err := r.Path(99, "whatever.zip"); err == nil {
		t.Error("Path resolved a snapshot that doesn't exist")
	}
}

// Retention keeps the newest N; a keep of zero or less is treated as the
// default rather than deleting everything.
func TestPruneHonoursKeep(t *testing.T) {
	r := testRunner(t)
	srv := srvWith(fakeSave(t))
	ctx := context.Background()

	// Three snapshots at distinct timestamps. Each is renamed a day further
	// back so the next backup can't collide on the second-resolution stamp
	// the archive name is built from.
	dir := filepath.Join(r.root, "7")
	for i := 0; i < 3; i++ {
		if _, err := r.BackupNow(ctx, srv); err != nil {
			t.Fatal(err)
		}
		snaps, _ := r.List(srv.ID)
		if len(snaps) == 0 {
			t.Fatal("no snapshot after a backup")
		}
		aged := time.Now().UTC().AddDate(0, 0, -(i+1)).Format(nameFormat) + ".zip"
		if err := os.Rename(filepath.Join(dir, snaps[0].Name), filepath.Join(dir, aged)); err != nil {
			t.Fatal(err)
		}
	}

	removed, err := r.prune(srv.ID, 2)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if removed != 1 {
		t.Errorf("pruned %d, want 1", removed)
	}
	if snaps, _ := r.List(srv.ID); len(snaps) != 2 {
		t.Errorf("kept %d snapshots, want 2", len(snaps))
	}
}

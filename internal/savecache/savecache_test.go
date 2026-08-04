package savecache_test

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/savecache"
)

// world is a stand-in for a game's parsed save.
type world struct {
	Generation int64
	ModTime    time.Time
}

// fakeSource counts parses and can be made slow, so the tests can observe
// what happens to a caller that arrives mid-parse.
type fakeSource struct {
	file   string // basename of the save file inside a save directory
	delay  time.Duration
	parses atomic.Int64
}

func (s *fakeSource) Locate(savePath string) (string, error) {
	info, err := os.Stat(savePath)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return filepath.Join(savePath, s.file), nil
	}
	return savePath, nil
}

func (s *fakeSource) Parse(ctx context.Context, file string, modTime time.Time) (*world, error) {
	if s.delay > 0 {
		select {
		case <-time.After(s.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return &world{Generation: s.parses.Add(1), ModTime: modTime}, nil
}

func makeSave(t *testing.T, dir, name, file string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, file), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadCachesUntilModTimeMoves(t *testing.T) {
	src := &fakeSource{file: "Level.sav"}
	c := savecache.New[world](src)
	dir := t.TempDir()
	save := makeSave(t, dir, "world", "Level.sav")

	first, err := c.Read(context.Background(), save)
	if err != nil {
		t.Fatal(err)
	}
	again, err := c.Read(context.Background(), save)
	if err != nil {
		t.Fatal(err)
	}
	if first != again || src.parses.Load() != 1 {
		t.Fatalf("second read re-parsed: parses=%d", src.parses.Load())
	}

	sav := filepath.Join(save, "Level.sav")
	if err := os.Chtimes(sav, time.Now(), time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	moved, err := c.Read(context.Background(), save)
	if err != nil {
		t.Fatal(err)
	}
	if moved == first || src.parses.Load() != 2 {
		t.Fatalf("changed save was not re-parsed: parses=%d", src.parses.Load())
	}
}

// A cached result for one save must return immediately even while another
// save's parse holds the parse lock — with several servers configured, the
// pages of server A shouldn't stall on server B's slow parse.
func TestCachedReadNotBlockedByOtherParse(t *testing.T) {
	src := &fakeSource{file: "Level.sav", delay: time.Second}
	c := savecache.New[world](src)
	dir := t.TempDir()
	saveA := makeSave(t, dir, "a", "Level.sav")
	saveB := makeSave(t, dir, "b", "Level.sav")

	// Prime the cache for A (pays one parse).
	if _, err := c.Read(context.Background(), saveA); err != nil {
		t.Fatal(err)
	}

	// B's parse runs in the background, holding the parse lock ~1s.
	done := make(chan error, 1)
	go func() {
		_, err := c.Read(context.Background(), saveB)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond) // let B reach the parser

	begin := time.Now()
	if _, err := c.Read(context.Background(), saveA); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(begin); d > 500*time.Millisecond {
		t.Errorf("cached read for A blocked %v behind B's parse", d)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A stale entry must be served immediately — not block behind the re-parse —
// and the re-parse must land in the cache shortly after.
func TestReadServeStale(t *testing.T) {
	src := &fakeSource{file: "Level.sav", delay: time.Second}
	c := savecache.New[world](src)
	dir := t.TempDir()
	save := makeSave(t, dir, "world", "Level.sav")
	sav := filepath.Join(save, "Level.sav")

	// First load has nothing to serve, so it blocks on the parse.
	first, err := c.ReadServeStale(context.Background(), save)
	if err != nil {
		t.Fatal(err)
	}

	// The save moves on; the stale parse must come back without waiting the
	// parser's full second.
	if err := os.Chtimes(sav, time.Now(), time.Now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	begin := time.Now()
	stale, err := c.ReadServeStale(context.Background(), save)
	if err != nil {
		t.Fatal(err)
	}
	if stale != first {
		t.Fatal("expected the stale cached result while refresh runs")
	}
	if d := time.Since(begin); d > 500*time.Millisecond {
		t.Errorf("stale serve blocked %v behind the refresh", d)
	}

	// The background refresh replaces the entry.
	deadline := time.Now().Add(5 * time.Second)
	for {
		fresh, err := c.ReadServeStale(context.Background(), save)
		if err != nil {
			t.Fatal(err)
		}
		if fresh != first {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background refresh never landed")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Refresh parses only when there is real work: a changed, settled save.
func TestRefresh(t *testing.T) {
	src := &fakeSource{file: "Level.sav"}
	c := savecache.New[world](src)
	dir := t.TempDir()
	save := makeSave(t, dir, "world", "Level.sav")
	sav := filepath.Join(save, "Level.sav")

	settle := func(age time.Duration) {
		if err := os.Chtimes(sav, time.Now(), time.Now().Add(-age)); err != nil {
			t.Fatal(err)
		}
	}

	settle(time.Minute)
	if parsed, err := c.Refresh(context.Background(), save); err != nil || !parsed {
		t.Fatalf("cold refresh: parsed=%v err=%v, want a parse", parsed, err)
	}
	if parsed, err := c.Refresh(context.Background(), save); err != nil || parsed {
		t.Fatalf("fresh refresh: parsed=%v err=%v, want a no-op", parsed, err)
	}

	// Just-written saves are left alone until they settle.
	if err := os.Chtimes(sav, time.Now(), time.Now()); err != nil {
		t.Fatal(err)
	}
	if parsed, err := c.Refresh(context.Background(), save); err != nil || parsed {
		t.Fatalf("unsettled refresh: parsed=%v err=%v, want a no-op", parsed, err)
	}

	// Once settled, the change is picked up.
	settle(10 * time.Second)
	if parsed, err := c.Refresh(context.Background(), save); err != nil || !parsed {
		t.Fatalf("settled refresh: parsed=%v err=%v, want a parse", parsed, err)
	}
}

func TestUnconfiguredSavePath(t *testing.T) {
	c := savecache.New[world](&fakeSource{file: "Level.sav"})
	for _, call := range []struct {
		name string
		err  error
	}{
		{"Read", func() error { _, err := c.Read(context.Background(), ""); return err }()},
		{"ReadServeStale", func() error { _, err := c.ReadServeStale(context.Background(), ""); return err }()},
		{"Refresh", func() error { _, err := c.Refresh(context.Background(), ""); return err }()},
	} {
		if call.err != savecache.ErrNotConfigured {
			t.Errorf("%s with empty path = %v, want ErrNotConfigured", call.name, call.err)
		}
	}
}

package collector

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/agentfiles"
	"github.com/safwyls/palcon/internal/store"
)

// fakeReader stands in for a game's save reader, recording which paths the
// warmer asked it to re-parse.
type fakeReader struct {
	mu     sync.Mutex
	paths  []string
	parsed bool
	err    error
}

func (f *fakeReader) Refresh(_ context.Context, savePath string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.paths = append(f.paths, savePath)
	return f.parsed, f.err
}

func (f *fakeReader) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.paths)
}

func newRefresher(t *testing.T, st *store.Store, reader SaveReader) *SaveRefresher {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewSaveRefresher(st, reader, agentfiles.New(t.TempDir(), logger), logger)
}

// addSaveServer stores a row with a local save path — what makes it a
// candidate for warming.
func addSaveServer(t *testing.T, st *store.Store, savePath string, enabled bool) *store.Server {
	t.Helper()
	srv := &store.Server{
		Name: "main", Host: "10.0.0.5", Enabled: enabled,
		SavePath: savePath, RCONPort: 25575, RESTPort: 8212,
	}
	id, err := st.CreateServer(context.Background(), srv)
	if err != nil {
		t.Fatal(err)
	}
	srv.ID = id
	return srv
}

func TestRefreshWarmsAConfiguredSave(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{}
	dir := t.TempDir()
	addSaveServer(t, st, dir, true)

	newRefresher(t, st, reader).refreshAll(context.Background())

	if reader.count() != 1 {
		t.Fatalf("refreshes = %d, want 1", reader.count())
	}
	if reader.paths[0] != dir {
		t.Errorf("refreshed %q, want the configured save path", reader.paths[0])
	}
}

// The warmer's gates: a disabled server, or one with no save configured, is
// nothing to warm.
func TestRefreshSkipsServersWithoutASave(t *testing.T) {
	t.Run("disabled", func(t *testing.T) {
		st := newStore(t)
		reader := &fakeReader{}
		addSaveServer(t, st, t.TempDir(), false)

		newRefresher(t, st, reader).refreshAll(context.Background())
		if reader.count() != 0 {
			t.Errorf("a disabled server was warmed: %d refreshes", reader.count())
		}
	})

	t.Run("no save path", func(t *testing.T) {
		st := newStore(t)
		reader := &fakeReader{}
		addSaveServer(t, st, "", true)

		newRefresher(t, st, reader).refreshAll(context.Background())
		if reader.count() != 0 {
			t.Errorf("a server with no save was warmed: %d refreshes", reader.count())
		}
	})
}

// A parse that actually ran books the next attempt into the future, so a
// game autosaving every 30s can't drive a parse on every poll.
func TestAParsedSaveIsNotReparsedImmediately(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{parsed: true}
	addSaveServer(t, st, t.TempDir(), true)
	r := newRefresher(t, st, reader)

	r.refreshAll(context.Background())
	r.refreshAll(context.Background())
	r.refreshAll(context.Background())

	if reader.count() != 1 {
		t.Errorf("refreshes = %d, want the attempt floor to hold it at 1", reader.count())
	}
}

// A cheap no-op check (the save hasn't changed) costs one stat, so it isn't
// rate-limited — polling can stay tight.
func TestAnUnchangedSaveKeepsPolling(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{parsed: false}
	addSaveServer(t, st, t.TempDir(), true)
	r := newRefresher(t, st, reader)

	r.refreshAll(context.Background())
	r.refreshAll(context.Background())

	if reader.count() != 2 {
		t.Errorf("refreshes = %d, want an unchanged save to be re-checked", reader.count())
	}
}

// A failing parse is spaced out too, so a permanently broken save doesn't
// burn CPU on every tick.
func TestAFailingParseIsBackedOff(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{err: errors.New("torn save")}
	addSaveServer(t, st, t.TempDir(), true)
	r := newRefresher(t, st, reader)

	r.refreshAll(context.Background())
	r.refreshAll(context.Background())

	if reader.count() != 1 {
		t.Errorf("refreshes = %d, want a failing save backed off to 1", reader.count())
	}
}

// Each server gets its own spacing — one server's recent parse must not
// starve another's.
func TestAttemptSpacingIsPerServer(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{parsed: true}
	addSaveServer(t, st, t.TempDir(), true)
	addSaveServer(t, st, t.TempDir(), true)

	newRefresher(t, st, reader).refreshAll(context.Background())

	if reader.count() != 2 {
		t.Errorf("refreshes = %d, want one per server", reader.count())
	}
}

func TestRefreshAllWithNoServers(t *testing.T) {
	newRefresher(t, newStore(t), &fakeReader{}).refreshAll(context.Background())
}

// A cancelled context stops the sweep partway rather than working through
// every remaining server.
func TestRefreshAllStopsOnACancelledContext(t *testing.T) {
	st := newStore(t)
	reader := &fakeReader{}
	for i := 0; i < 3; i++ {
		addSaveServer(t, st, t.TempDir(), true)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	newRefresher(t, st, reader).refreshAll(ctx)

	if reader.count() > 1 {
		t.Errorf("the sweep kept going after cancellation: %d refreshes", reader.count())
	}
}

func TestSaveRefresherRunStopsOnContextCancel(t *testing.T) {
	r := newRefresher(t, newStore(t), &fakeReader{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
}

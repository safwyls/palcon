package collector

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/crypto"
	"github.com/safwyls/palcon/internal/db"
	"github.com/safwyls/palcon/internal/game"
	"github.com/safwyls/palcon/internal/store"
)

// stubClient serves a fixed player list; only Players is exercised by the
// watch loop, the rest satisfies the interface.
type stubClient struct{ players []game.Player }

func (s *stubClient) Info(context.Context) (*game.ServerInfo, error) {
	return &game.ServerInfo{}, nil
}
func (s *stubClient) Players(context.Context) ([]game.Player, error) { return s.players, nil }
func (s *stubClient) Broadcast(context.Context, string) error        { return nil }
func (s *stubClient) Kick(context.Context, string, string) error     { return nil }
func (s *stubClient) Ban(context.Context, string, string) error      { return nil }
func (s *stubClient) Unban(context.Context, string) error            { return nil }
func (s *stubClient) Save(context.Context) error                     { return nil }
func (s *stubClient) Shutdown(context.Context, int, string) error    { return nil }

func online(names ...string) *stubClient {
	c := &stubClient{}
	for _, n := range names {
		c.players = append(c.players, game.Player{Name: n, UserID: "steam_" + n})
	}
	return c
}

func newTestCollector(t *testing.T) (*Collector, *store.Store, *store.Server) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	box, err := crypto.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatalf("crypto: %v", err)
	}
	st := store.New(sqlDB, box)
	srv := &store.Server{Name: "main", Host: "127.0.0.1", RCONPort: 25575, RESTPort: 8212, Enabled: true}
	if srv.ID, err = st.CreateServer(context.Background(), srv); err != nil {
		t.Fatalf("create server: %v", err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(st, nil, logger), st, srv
}

type event struct {
	name  string
	event string
	ts    time.Time
}

func eventsFor(t *testing.T, st *store.Store, srv *store.Server) []event {
	t.Helper()
	raw, err := st.ListPlayerEvents(context.Background(), srv.ID, time.Time{})
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	// Oldest-first reads like the timeline it describes.
	out := make([]event, 0, len(raw))
	for i := len(raw) - 1; i >= 0; i-- {
		out = append(out, event{raw[i].Name, raw[i].Event, raw[i].TS})
	}
	return out
}

// The bug this guards: palcon restarting while someone is online used to
// strand their join with no matching leave, and a dangling join reads as a
// session still running now — a full extra day of playtime per day since.
func TestRestartClosesSessionsAtLastObservation(t *testing.T) {
	ctx := context.Background()
	c1, st, srv := newTestCollector(t)

	// Run 1: Kyoshi is on when palcon starts watching, and still on when
	// palcon is killed without a chance to clean up.
	c1.watch(ctx, srv, online("Kyoshi"))
	lastSeen, err := st.LastWatch(ctx, srv.ID)
	if err != nil || lastSeen.IsZero() {
		t.Fatalf("heartbeat after a probe = %v (err %v), want a timestamp", lastSeen, err)
	}

	// Run 2: a fresh process, and Kyoshi logged off during the downtime so
	// the server never reports him again.
	c2, _, _ := newTestCollector(t)
	c2.store = st
	c2.watch(ctx, srv, online())

	got := eventsFor(t, st, srv)
	if len(got) != 2 || got[0].event != "join" || got[1].event != "leave" {
		t.Fatalf("events = %+v, want a join closed by a leave", got)
	}
	if !got[1].ts.Equal(lastSeen.UTC().Truncate(time.Second)) {
		t.Errorf("leave at %v, want the last observation %v", got[1].ts, lastSeen)
	}
	// The session must be bounded by what palcon watched, not open-ended.
	if d := got[1].ts.Sub(got[0].ts); d < 0 || d > time.Minute {
		t.Errorf("session lasted %v, want roughly the length of run 1", d)
	}
}

// A player still online across a restart gets their session closed where
// observation stopped and a new one opened where it resumed, so palcon's
// downtime is credited to nobody — the same rule a server outage follows.
func TestRestartReopensSessionForPlayerStillOnline(t *testing.T) {
	ctx := context.Background()
	c1, st, srv := newTestCollector(t)
	c1.watch(ctx, srv, online("Kyoshi"))

	c2, _, _ := newTestCollector(t)
	c2.store = st
	c2.watch(ctx, srv, online("Kyoshi"))

	got := eventsFor(t, st, srv)
	if len(got) != 3 {
		t.Fatalf("events = %+v, want join / leave / join", got)
	}
	want := []string{"join", "leave", "join"}
	for i, w := range want {
		if got[i].event != w || got[i].name != "Kyoshi" {
			t.Fatalf("event %d = %+v, want a %s for Kyoshi", i, got[i], w)
		}
	}
	// Still open, so the next tick can close it normally.
	open, err := st.OpenSessions(ctx, srv.ID)
	if err != nil || len(open) != 1 {
		t.Fatalf("open sessions = %+v (err %v), want the reopened one", open, err)
	}
}

// The graceful path: stopping palcon ends the sessions it knows about, so a
// restart has nothing left to reconcile and no downtime is attributed.
func TestCloseSessionsOnShutdown(t *testing.T) {
	ctx := context.Background()
	c, st, srv := newTestCollector(t)
	c.watch(ctx, srv, online("Kyoshi", "Rushi"))

	c.closeSessions(ctx)

	open, err := st.OpenSessions(ctx, srv.ID)
	if err != nil {
		t.Fatalf("open sessions: %v", err)
	}
	if len(open) != 0 {
		t.Fatalf("open sessions after shutdown = %+v, want none", open)
	}
	if got := eventsFor(t, st, srv); len(got) != 4 {
		t.Fatalf("events = %+v, want two joins and two leaves", got)
	}
}

// A first start under the new schema has no heartbeat to lean on. Crediting
// nothing is the honest answer — an unbounded session is not.
func TestResumeWithoutHeartbeatCreditsNothing(t *testing.T) {
	ctx := context.Background()
	c, st, srv := newTestCollector(t)

	joinedAt := time.Now().Add(-30 * time.Hour).UTC().Truncate(time.Second)
	if err := st.InsertPlayerEvent(ctx, srv.ID, joinedAt, "steam_Kyoshi", "", "Kyoshi", "join"); err != nil {
		t.Fatalf("seed join: %v", err)
	}

	c.watch(ctx, srv, online())

	got := eventsFor(t, st, srv)
	if len(got) != 2 || got[1].event != "leave" {
		t.Fatalf("events = %+v, want the stale join closed", got)
	}
	if !got[1].ts.Equal(joinedAt) {
		t.Errorf("leave at %v, want the join time %v (a zero-length session)", got[1].ts, joinedAt)
	}
}

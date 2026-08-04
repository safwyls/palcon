package collector

import (
	"context"
	"time"

	"github.com/safwyls/palcon/internal/game"
	"github.com/safwyls/palcon/internal/store"
)

// downAfter is how many consecutive failed probes declare a server down.
// At the sampling Interval that's ~1 minute of silence — long enough to
// ride out one dropped request, short enough to still be news.
const downAfter = 2

// serverState is the per-server memory behind the activity log and Discord
// notifications: enough to tell a transition from steady state, and last
// tick's player list to diff joins/leaves against.
type serverState struct {
	// primed is false until the first successful probe, which reconciles
	// the events table with reality rather than diffing against nothing.
	primed bool
	fails  int
	down   bool
	// downSince timestamps the failure that began the outage, for the
	// "back online after X" message.
	downSince time.Time
	// players maps UserID → who they were as of the last successful probe.
	players map[string]watched
}

// watched is what the collector remembers about a player between ticks: the
// display name for the event log, and the in-game uid that lets a later
// reader join an observed leave to that player in the save.
type watched struct {
	uid  string
	name string
}

// watch probes the server's player list each tick and turns changes into
// player_events rows (always) and Discord notifications (gated inside the
// notifier by each server's webhook config).
func (c *Collector) watch(ctx context.Context, srv *store.Server, client game.Client) {
	players, err := client.Players(ctx)
	now := time.Now()

	c.mu.Lock()
	st := c.watchState[srv.ID]
	if st == nil {
		st = &serverState{}
		c.watchState[srv.ID] = st
	}

	if err != nil {
		st.fails++
		if !st.down && st.fails == downAfter {
			st.down = true
			st.downSince = now.Add(-time.Duration(downAfter-1) * Interval)
			// Everyone we knew about was just disconnected; closing their
			// sessions at the outage start keeps playtime honest.
			disconnected := st.players
			st.players = nil
			c.mu.Unlock()
			for userID, w := range disconnected {
				c.recordEvent(ctx, srv.ID, st.downSince, userID, w.uid, w.name, "leave")
			}
			if c.notifier != nil {
				c.notifier.ServerDown(ctx, srv)
			}
			return
		}
		c.mu.Unlock()
		return
	}

	wasDown := st.down
	downSince := st.downSince
	st.fails = 0
	st.down = false

	current := make(map[string]watched, len(players))
	for _, p := range players {
		// UserID is the stable identity (PlayerUID changes format across
		// transports); names are display-only. The uid is canonicalised on
		// the way in so what lands in the events table can be compared with
		// a save's PlayerUId without every reader redoing the spelling.
		current[p.UserID] = watched{uid: srv.CanonicalUID(p.PlayerUID), name: p.Name}
	}
	prev := st.players
	primed := st.primed
	st.players = current
	st.primed = true
	c.mu.Unlock()

	// Read before the heartbeat below overwrites it: resume needs the
	// *previous* run's value, which is where observation actually stopped.
	var lastSeen time.Time
	if !primed {
		if lastSeen, err = c.store.LastWatch(ctx, srv.ID); err != nil {
			c.logger.Error("collector: reading watch heartbeat", "server", srv.ID, "error", err)
		}
	}
	// Written on every successful probe, not only the ones that produce an
	// event: it's the record of how much palcon actually watched.
	if err := c.store.TouchWatch(ctx, srv.ID, now); err != nil {
		c.logger.Error("collector: recording watch heartbeat", "server", srv.ID, "error", err)
	}

	if c.notifier != nil && wasDown {
		c.notifier.ServerUp(ctx, srv, time.Since(downSince))
	}
	// First observation of this run: reconcile with what the events table
	// still believes rather than diffing against an empty player list.
	if !primed {
		c.resume(ctx, srv, current, lastSeen, now)
		return
	}

	for userID, w := range current {
		if _, ok := prev[userID]; !ok {
			c.recordEvent(ctx, srv.ID, now, userID, w.uid, w.name, "join")
			// After downtime the whole list reads as joins — real ones,
			// since their sessions were closed when the server went down —
			// but Discord shouldn't announce a restart as player churn.
			if c.notifier != nil && !wasDown {
				c.notifier.PlayerJoined(ctx, srv, w.name, len(current))
			}
		}
	}
	for userID, w := range prev {
		if _, ok := current[userID]; !ok {
			c.recordEvent(ctx, srv.ID, now, userID, w.uid, w.name, "leave")
			if c.notifier != nil && !wasDown {
				c.notifier.PlayerLeft(ctx, srv, w.name, len(current))
			}
		}
	}
}

// resume reconciles the events table on palcon's first look at a server.
//
// Palcon's own downtime is invisible from the server's side: a player who
// was online at shutdown left a join with no leave, and anything reading
// the log later has no way to know the session ended — it reads as still
// running, growing by a day every day. So close everything still open at
// the last instant palcon was actually watching, then open a fresh session
// for whoever is on the server now. Time palcon did not observe belongs to
// nobody, which is the same rule a server outage already follows.
func (c *Collector) resume(ctx context.Context, srv *store.Server, current map[string]watched, lastSeen, now time.Time) {
	open, err := c.store.OpenSessions(ctx, srv.ID)
	if err != nil {
		c.logger.Error("collector: reading open sessions", "server", srv.ID, "error", err)
		return
	}
	for _, s := range open {
		at := lastSeen
		// No heartbeat yet (the first start after this shipped), or a clock
		// that moved: never close a session before it opened or in the
		// future. Crediting nothing beats crediting a day nobody played.
		if at.Before(s.Since) {
			at = s.Since
		}
		if at.After(now) {
			at = now
		}
		c.recordEvent(ctx, srv.ID, at, s.UserID, s.PlayerUID, s.Name, "leave")
	}
	if len(open) > 0 {
		c.logger.Info("collector: closed sessions left open by a previous run",
			"server", srv.ID, "sessions", len(open), "at", lastSeen)
	}
	// Deliberately silent on Discord: palcon starting up is not player
	// churn, exactly as a server coming back up isn't.
	for userID, w := range current {
		c.recordEvent(ctx, srv.ID, now, userID, w.uid, w.name, "join")
	}
}

// closeSessions ends every session palcon currently believes is open. Run
// on the way out so a restart doesn't strand them: the player was online up
// to this instant, and what happens after is unobserved.
func (c *Collector) closeSessions(ctx context.Context) {
	now := time.Now()
	c.mu.Lock()
	state := c.watchState
	c.watchState = make(map[int64]*serverState)
	c.mu.Unlock()

	for id, st := range state {
		// A server already declared down had its sessions closed at the
		// outage; st.players is nil there, so this writes nothing twice.
		for userID, w := range st.players {
			c.recordEvent(ctx, id, now, userID, w.uid, w.name, "leave")
		}
	}
}

func (c *Collector) recordEvent(ctx context.Context, serverID int64, at time.Time, userID, playerUID, name, event string) {
	if err := c.store.InsertPlayerEvent(ctx, serverID, at, userID, playerUID, name, event); err != nil {
		c.logger.Error("collector: recording player event", "server", serverID, "event", event, "error", err)
	}
}

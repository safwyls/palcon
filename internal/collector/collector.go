// Package collector periodically samples each server's health into
// server_metrics, so the dashboard can chart performance over time rather
// than only showing the instant the page happened to load.
package collector

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/safwyls/palcon/internal/game"
	"github.com/safwyls/palcon/internal/notify"
	"github.com/safwyls/palcon/internal/store"
)

const (
	// Interval between samples. Frequent enough to show a lag spike, slow
	// enough that a handful of servers costs one small HTTP request each
	// per interval.
	Interval = 30 * time.Second
	// Retention is how far back charts can look; at Interval that's about
	// 20k rows per server, which sqlite handles without noticing.
	Retention = 7 * 24 * time.Hour
	// ActivityRetention bounds the player join/leave history. Events are
	// sparse (rows only when someone comes or goes), so three months stays
	// tiny.
	ActivityRetention = 90 * 24 * time.Hour
	// AuditRetention keeps the admin-action trail for a year — it's the
	// record consulted least often and missed most when it's gone.
	AuditRetention = 365 * 24 * time.Hour
	// pruneEvery is deliberately much coarser than Interval — deleting a
	// few expired rows is not urgent work.
	pruneEvery = time.Hour
)

type Collector struct {
	store  *store.Store
	logger *slog.Logger
	// notifier turns reachability changes and player joins/leaves into
	// Discord messages. Nil disables event watching entirely.
	notifier *notify.Notifier

	// unreachable tracks which servers are currently failing, so a server
	// that goes down logs once instead of every Interval forever.
	// Guarded by mu: samples run concurrently.
	mu          sync.Mutex
	unreachable map[int64]bool
	// watchState is the per-server notification state (also under mu).
	watchState map[int64]*serverState
}

func New(st *store.Store, notifier *notify.Notifier, logger *slog.Logger) *Collector {
	return &Collector{
		store:       st,
		logger:      logger,
		notifier:    notifier,
		unreachable: make(map[int64]bool),
		watchState:  make(map[int64]*serverState),
	}
}

// Run samples until ctx is cancelled. Intended to be started in a goroutine.
func (c *Collector) Run(ctx context.Context) {
	sampleTicker := time.NewTicker(Interval)
	defer sampleTicker.Stop()
	pruneTicker := time.NewTicker(pruneEvery)
	defer pruneTicker.Stop()

	c.sampleAll(ctx)
	c.prune(ctx)

	for {
		select {
		case <-ctx.Done():
			// Detached and bounded: ctx is already cancelled, and closing
			// out the open play sessions is the point of stopping cleanly.
			closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			c.closeSessions(closeCtx)
			cancel()
			return
		case <-sampleTicker.C:
			c.sampleAll(ctx)
		case <-pruneTicker.C:
			c.prune(ctx)
		}
	}
}

func (c *Collector) sampleAll(ctx context.Context) {
	servers, err := c.store.ListServers(ctx)
	if err != nil {
		c.logger.Error("metrics collector: listing servers", "error", err)
		return
	}
	// Concurrent, so a sweep costs the slowest server's probe (≤10s), not
	// the sum — several unreachable servers otherwise overrun the tick and
	// degrade sampling cadence for everyone. Server counts here are single
	// digits; no need to bound the fan-out.
	var wg sync.WaitGroup
	for _, srv := range servers {
		if !srv.Enabled {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.sample(ctx, srv)
		}()
	}
	wg.Wait()
}

func (c *Collector) sample(ctx context.Context, srv *store.Server) {
	// Bounded per server: one slow server must not delay the others past
	// the next tick.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	client, err := srv.Client()
	if err != nil {
		// A row naming a game this build doesn't have. Logged once per
		// sweep at info, not error: nothing here can fix it.
		c.logger.Info("metrics collector: skipping server", "server", srv.ID, "name", srv.Name, "error", err)
		return
	}

	// Reachability and join/leave watching rides the same tick, over the
	// player list (which both transports can serve).
	c.watch(ctx, srv, client)

	// Metrics are REST-only; an RCON-only server has nothing to sample and
	// isn't an error worth reporting.
	ext, ok := client.(game.ExtendedClient)
	if !ok {
		return
	}

	m, err := ext.Metrics(ctx)
	if err != nil {
		c.mu.Lock()
		firstFailure := !c.unreachable[srv.ID]
		c.unreachable[srv.ID] = true
		c.mu.Unlock()
		if firstFailure {
			c.logger.Info("metrics collector: server unreachable, pausing samples",
				"server", srv.ID, "name", srv.Name, "error", err)
		}
		return
	}
	c.mu.Lock()
	wasUnreachable := c.unreachable[srv.ID]
	delete(c.unreachable, srv.ID)
	c.mu.Unlock()
	if wasUnreachable {
		c.logger.Info("metrics collector: server reachable again", "server", srv.ID, "name", srv.Name)
	}

	players, maxPlayers := m.CurrentPlayerNum, m.MaxPlayerNum
	fps, frame := m.ServerFPS, m.ServerFrameTime
	sample := store.MetricSample{
		TS:          time.Now().UTC(),
		PlayerCount: &players,
		MaxPlayers:  &maxPlayers,
		ServerFPS:   &fps,
		FrameTime:   &frame,
	}
	if err := c.store.InsertMetric(ctx, srv.ID, sample); err != nil {
		c.logger.Error("metrics collector: inserting sample", "server", srv.ID, "error", err)
	}
}

func (c *Collector) prune(ctx context.Context) {
	now := time.Now().UTC()
	for _, p := range []struct {
		what string
		fn   func(context.Context, time.Time) (int64, error)
		keep time.Duration
	}{
		{"metric samples", c.store.PruneMetrics, Retention},
		{"player events", c.store.PrunePlayerEvents, ActivityRetention},
		{"audit entries", c.store.PruneAudit, AuditRetention},
	} {
		n, err := p.fn(ctx, now.Add(-p.keep))
		if err != nil {
			c.logger.Error("collector: pruning "+p.what, "error", err)
			continue
		}
		if n > 0 {
			c.logger.Info("collector: pruned expired "+p.what, "rows", n)
		}
	}
}

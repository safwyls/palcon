// Package collector periodically samples each server's health into
// server_metrics, so the dashboard can chart performance over time rather
// than only showing the instant the page happened to load.
package collector

import (
	"context"
	"log/slog"
	"time"

	"github.com/safwyls/palcon/internal/palworld"
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
	// pruneEvery is deliberately much coarser than Interval — deleting a
	// few expired rows is not urgent work.
	pruneEvery = time.Hour
)

type Collector struct {
	store  *store.Store
	logger *slog.Logger

	// unreachable tracks which servers are currently failing, so a server
	// that goes down logs once instead of every Interval forever.
	unreachable map[int64]bool
}

func New(st *store.Store, logger *slog.Logger) *Collector {
	return &Collector{store: st, logger: logger, unreachable: make(map[int64]bool)}
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
	for _, srv := range servers {
		if !srv.Enabled {
			continue
		}
		c.sample(ctx, srv)
	}
}

func (c *Collector) sample(ctx context.Context, srv *store.Server) {
	// Bounded per server: one slow server must not delay the others past
	// the next tick.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	client := palworld.New(palworld.Config{
		Host:         srv.Host,
		RESTPort:     srv.RESTPort,
		RESTPassword: srv.RESTPassword,
		RCONPort:     srv.RCONPort,
		RCONPassword: srv.RCONPassword,
		PreferREST:   srv.UseREST,
	})

	// Metrics are REST-only; an RCON-only server has nothing to sample and
	// isn't an error worth reporting.
	ext, ok := client.(palworld.ExtendedClient)
	if !ok {
		return
	}

	m, err := ext.Metrics(ctx)
	if err != nil {
		if !c.unreachable[srv.ID] {
			c.unreachable[srv.ID] = true
			c.logger.Info("metrics collector: server unreachable, pausing samples",
				"server", srv.ID, "name", srv.Name, "error", err)
		}
		return
	}
	if c.unreachable[srv.ID] {
		delete(c.unreachable, srv.ID)
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
	n, err := c.store.PruneMetrics(ctx, time.Now().UTC().Add(-Retention))
	if err != nil {
		c.logger.Error("metrics collector: pruning", "error", err)
		return
	}
	if n > 0 {
		c.logger.Info("metrics collector: pruned expired samples", "rows", n)
	}
}

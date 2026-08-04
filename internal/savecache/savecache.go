// Package savecache caches parsed world-save data, keyed on the save file's
// modification time.
//
// Reading a world save is expensive — seconds of CPU and a whole decompressed
// world in memory — while the file itself only changes on the game's autosave
// cycle. That mismatch is what this package manages, and none of it is
// specific to any game:
//
//   - a parse is reused until the file's mtime moves;
//   - only one parse runs at a time, because each holds a whole world;
//   - a request that arrives while a parse is in flight waits for that one
//     rather than starting a second;
//   - ReadServeStale hands back the previous parse immediately and refreshes
//     behind the request, so a page load never blocks on the extractor;
//   - a just-written file is left to settle, because parsing a half-written
//     save fails or, worse, half-succeeds.
//
// A game supplies only a Source: where the save file is, and how to turn it
// into that game's own result type.
package savecache

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ErrNotConfigured is returned for a server with no save path set.
var ErrNotConfigured = errors.New("no save path configured for this server")

// Source reads one game's world save.
type Source[T any] interface {
	// Locate resolves a configured save path — which may be the directory
	// holding the world file, or the file itself — to the single file whose
	// mtime decides whether a cached parse is stale.
	Locate(savePath string) (string, error)
	// Parse reads that file. modTime is passed through so the result can
	// record which vintage of the save it came from; the cache never
	// inspects the value it gets back.
	Parse(ctx context.Context, file string, modTime time.Time) (*T, error)
}

const (
	// maxEntries bounds the cache (one entry per save file). Each entry
	// holds a whole parsed world (tens of MB); without a cap, a deleted
	// server or changed save path would strand its entry forever.
	maxEntries = 8
	// defaultParseTimeout bounds one extraction.
	defaultParseTimeout = 2 * time.Minute
	// defaultWriteSettle is how old a save's mtime must be before Refresh
	// will read it. Games write the file in place, so a file still being
	// written is not safely parseable.
	defaultWriteSettle = 3 * time.Second
)

type entry[T any] struct {
	modTime  time.Time
	parsedAt time.Time
	result   *T
}

// Cache is a Source plus its parse cache. Safe for concurrent use.
type Cache[T any] struct {
	src Source[T]

	// ParseTimeout bounds one call to Source.Parse; zero means two minutes.
	ParseTimeout time.Duration
	// WriteSettle is how recently the save may have been written for
	// Refresh to skip it; zero means three seconds.
	WriteSettle time.Duration

	// mu guards the maps, so a cached read for one save never waits behind
	// another save's parse. parseMu serializes extractions: each holds a
	// whole decompressed world, so running them concurrently risks memory
	// spikes.
	mu    sync.Mutex
	cache map[string]entry[T]
	// refreshing tracks saves with a background re-parse in flight, so
	// stale serves don't stack up duplicate refresh goroutines.
	refreshing map[string]bool
	parseMu    sync.Mutex
}

// New builds a cache over src.
func New[T any](src Source[T]) *Cache[T] {
	return &Cache[T]{
		src:        src,
		cache:      make(map[string]entry[T]),
		refreshing: make(map[string]bool),
	}
}

func (c *Cache[T]) parseTimeout() time.Duration {
	if c.ParseTimeout > 0 {
		return c.ParseTimeout
	}
	return defaultParseTimeout
}

func (c *Cache[T]) writeSettle() time.Duration {
	if c.WriteSettle > 0 {
		return c.WriteSettle
	}
	return defaultWriteSettle
}

// stat resolves savePath to its save file and that file's mtime.
func (c *Cache[T]) stat(savePath string) (string, time.Time, error) {
	if savePath == "" {
		return "", time.Time{}, ErrNotConfigured
	}
	file, err := c.src.Locate(savePath)
	if err != nil {
		return "", time.Time{}, err
	}
	info, err := os.Stat(file)
	if err != nil {
		// Named, not generic: "Level.sav not accessible" tells an operator
		// which file to go looking for.
		return "", time.Time{}, fmt.Errorf("%s not accessible: %w", filepath.Base(file), err)
	}
	return file, info.ModTime(), nil
}

// Read returns the parsed save, re-running the extractor only when the file's
// mtime has moved since the cached parse.
func (c *Cache[T]) Read(ctx context.Context, savePath string) (*T, error) {
	file, modTime, err := c.stat(savePath)
	if err != nil {
		return nil, err
	}
	if result, ok := c.fresh(file, modTime); ok {
		return result, nil
	}

	// One extraction at a time overall (see parseMu). Taking the parse lock
	// can mean waiting behind another save's parse, so re-check the cache
	// after acquiring it: a queued request for the same save should reuse
	// the winner's result instead of parsing again.
	c.parseMu.Lock()
	defer c.parseMu.Unlock()

	if result, ok := c.fresh(file, modTime); ok {
		return result, nil
	}

	ctx, cancel := context.WithTimeout(ctx, c.parseTimeout())
	defer cancel()

	result, err := c.src.Parse(ctx, file, modTime)
	if err != nil {
		return nil, err
	}
	c.store(file, modTime, result)
	return result, nil
}

// ReadServeStale returns the freshest parse available without making the
// caller wait for one: an up-to-date entry is returned as-is, a stale entry
// (the save changed since it was parsed) is returned immediately while a
// re-parse runs in the background, and only a save with no cached parse at
// all blocks on the extractor. A background refresh failure just leaves the
// stale entry standing.
func (c *Cache[T]) ReadServeStale(ctx context.Context, savePath string) (*T, error) {
	file, modTime, err := c.stat(savePath)
	if err != nil {
		return nil, err
	}
	if result, ok := c.fresh(file, modTime); ok {
		return result, nil
	}
	if stale, ok := c.any(file); ok {
		c.refreshAsync(savePath, file)
		return stale, nil
	}
	return c.Read(ctx, savePath)
}

// Refresh re-parses savePath if the save has changed, so the cache is warm
// before anyone asks. Freshly written files are left to settle; a fresh cache
// entry makes it a no-op. The bool reports whether a parse was actually
// attempted, so a caller can rate-limit real work without penalizing cheap
// no-op checks. Meant for a background loop — callers serving humans want
// Read or ReadServeStale.
func (c *Cache[T]) Refresh(ctx context.Context, savePath string) (bool, error) {
	file, modTime, err := c.stat(savePath)
	if err != nil {
		return false, err
	}
	if _, ok := c.fresh(file, modTime); ok {
		return false, nil
	}
	if time.Since(modTime) < c.writeSettle() {
		return false, nil
	}
	_, err = c.Read(ctx, savePath)
	return true, err
}

// fresh returns the cached parse for file if it matches modTime.
func (c *Cache[T]) fresh(file string, modTime time.Time) (*T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[file]
	if !ok || !e.modTime.Equal(modTime) {
		return nil, false
	}
	return e.result, true
}

// any returns whatever parse is cached for file, however the file has moved
// on since.
func (c *Cache[T]) any(file string) (*T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[file]
	if !ok {
		return nil, false
	}
	return e.result, true
}

func (c *Cache[T]) store(file string, modTime time.Time, result *T) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// Evicting the stalest parse keeps every active server's entry warm at
	// any plausible server count.
	if _, exists := c.cache[file]; !exists && len(c.cache) >= maxEntries {
		var oldestKey string
		var oldestAt time.Time
		for k, e := range c.cache {
			if oldestKey == "" || e.parsedAt.Before(oldestAt) {
				oldestKey, oldestAt = k, e.parsedAt
			}
		}
		delete(c.cache, oldestKey)
	}
	c.cache[file] = entry[T]{modTime: modTime, parsedAt: time.Now().UTC(), result: result}
}

// refreshAsync re-parses savePath in the background, at most once in flight
// per save file.
func (c *Cache[T]) refreshAsync(savePath, file string) {
	c.mu.Lock()
	if c.refreshing[file] {
		c.mu.Unlock()
		return
	}
	c.refreshing[file] = true
	c.mu.Unlock()

	go func() {
		// Read applies its own timeout; the requesting context would cancel
		// the refresh as soon as the stale response was written.
		_, _ = c.Read(context.Background(), savePath)
		c.mu.Lock()
		delete(c.refreshing, file)
		c.mu.Unlock()
	}()
}

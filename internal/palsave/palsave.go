// Package palsave reads Pal party/palbox data out of a Palworld Level.sav
// by shelling out to a bundled Python extractor built on palworld-save-tools
// (the community-standard GVAS implementation — deliberately not
// reimplemented in Go; see README "Phase 5").
//
// Read-only by design: the save file is only ever opened for reading.
package palsave

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//go:embed extract_pals.py
var extractScript []byte

// extract_pals.py imports this, so both have to land in the data dir.
//
//go:embed guilds.py
var guildsModule []byte

// ErrNotConfigured is returned for servers with no save path set.
var ErrNotConfigured = errors.New("no save path configured for this server")

type Pal struct {
	InstanceID    string   `json:"instanceId"`
	CharacterID   string   `json:"characterId"`
	Nickname      string   `json:"nickname"`
	Level         int      `json:"level"`
	Gender        string   `json:"gender"`
	IsBoss        bool     `json:"isBoss"`
	IsLucky       bool     `json:"isLucky"`
	Rank          int      `json:"rank"`
	TalentHP      int      `json:"talentHp"`
	TalentShot    int      `json:"talentShot"`
	TalentDefense int      `json:"talentDefense"`
	Passives      []string `json:"passives"`

	// Detail-view extras. Zero values are normal here: a pal that has never
	// been in a base has no sickness, and souls is empty until upgraded.
	Exp        int            `json:"exp"`
	Skills     []string       `json:"skills"`
	HP         int            `json:"hp"`
	Sanity     float64        `json:"sanity"`
	Stomach    float64        `json:"stomach"`
	Friendship int            `json:"friendship"`
	Sick       string         `json:"sick"`
	Souls      map[string]int `json:"souls"`
	SlotIndex  int            `json:"slotIndex"`
	// BaseID is the base camp a working pal belongs to (matches a guild
	// base's ID); empty for pals not working at a base.
	BaseID string `json:"baseId"`
}

// ItemSlot is one occupied slot of a player's inventory. Slot is the slot's
// position in the container's grid, which the save preserves — gaps in a bag
// are real gaps, so the viewer can lay a container out the way the game does.
type ItemSlot struct {
	Slot   int    `json:"slot"`
	ItemID string `json:"itemId"`
	Count  int    `json:"count"`

	// Per-instance state, present only for the "dynamic" items that carry
	// any: gear has durability (and guns a round count), eggs name the
	// species inside. Zero means the item has no such state, not that it's
	// broken or empty.
	Durability float64  `json:"durability,omitempty"`
	Ammo       int      `json:"ammo,omitempty"`
	EggSpecies string   `json:"eggSpecies,omitempty"`
	Passives   []string `json:"passives,omitempty"`
}

// ItemContainer is one of a player's bags. Size is its capacity in slots, so
// an empty slot can be told apart from a slot the player hasn't unlocked.
type ItemContainer struct {
	Size  int        `json:"size"`
	Slots []ItemSlot `json:"slots"`
}

// Character is the player's own save entry: level progress, current
// condition, and how they spent their stat points.
//
// Deliberately carries no derived totals. The Health/Attack/Defense/Work Speed
// figures the game's character screen shows are computed at runtime from base
// values, level and equipment; the save records none of them, so neither do
// we. HP and Shield are current values for the same reason — their maxima
// never touch the file.
type Character struct {
	Exp    int `json:"exp"`
	HP     int `json:"hp"`
	Shield int `json:"shield"`
	// Stomach is a real percentage, unlike a pal's species-dependent one.
	Stomach            float64 `json:"stomach"`
	UnusedStatusPoints int     `json:"unusedStatusPoints"`
	// The two pools the game tracks separately: points spent on level-up,
	// and the scarcer "Ex" ones. Keyed by English stat name.
	StatusPoints   map[string]int `json:"statusPoints"`
	ExStatusPoints map[string]int `json:"exStatusPoints"`
	// The food buff currently running, and its seconds remaining.
	FoodBuff        string `json:"foodBuff"`
	FoodBuffSeconds int    `json:"foodBuffSeconds"`
}

// Inventory holds a player's item containers, keyed by role: "common" (the
// backpack), "essential" (key items), "weapons", "equipment", "food" and
// "drop" (what a death would leave behind). Empty for a player whose save
// predates the layout the extractor reads.
type Inventory map[string]ItemContainer

type PlayerPals struct {
	UID      string `json:"uid"`
	Nickname string `json:"nickname"`
	Level    int    `json:"level"`
	Party    []Pal  `json:"party"`
	Palbox   []Pal  `json:"palbox"`
	Base     []Pal  `json:"base"`
	// Dimensional Pal Storage (Players/<uid>_dps.sav) plus this player's
	// share of the guild-wide GlobalPalStorage.sav.
	Storage []Pal `json:"storage"`

	// The player's item containers, from Level.sav's ItemContainerSaveData.
	Inventory Inventory `json:"inventory,omitempty"`

	// The player's own character entry. Nil for a uid that owns pals or bags
	// but has no player entry in this save.
	Character *Character `json:"character,omitempty"`

	// From Players/<uid>.sav. LastOnline is unix seconds, 0 when the save
	// didn't record one; LastX/LastY are world coordinates in the same
	// space the live map plots, so an offline player can still be placed.
	LastOnline       int64    `json:"lastOnline"`
	LastX            *float64 `json:"lastX"`
	LastY            *float64 `json:"lastY"`
	Platform         string   `json:"platform"`
	TechnologyPoints int      `json:"technologyPoints"`

	// Paldex progress from the player save's RecordData: Paldeck lists the
	// registered species (survives selling/releasing the pal), Captures the
	// per-species sphere-capture counts the game itself displays.
	Paldeck  []string       `json:"paldeck"`
	Captures map[string]int `json:"captures"`
}

type GuildMember struct {
	UID  string `json:"uid"`
	Name string `json:"name"`
}

type GuildBase struct {
	// ID is the camp's guid, which working pals reference via BaseID.
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

type Guild struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	BaseCampLevel int           `json:"baseCampLevel"`
	Members       []GuildMember `json:"members"`
	MemberCount   int           `json:"memberCount"`
	Bases         []GuildBase   `json:"bases"`
}

// Container kinds, as classify_storage in the extractor labels them.
const (
	// KindBase is a structure standing at a guild's base camp — the chests,
	// feed boxes, refrigerators and machines people actually stock.
	KindBase = "base"
	// KindWorld is a container the world placed with no base camp behind it:
	// the treasure boxes scattered across the map.
	KindWorld = "world"
	// KindGuild is the guild chest — storage a whole guild shares, reached
	// from any of its chests and so recorded with no position of its own.
	KindGuild = "guild"
	// KindUnplaced is real storage no surviving map object references, so the
	// save gives it no position. Rare, but it can hold a lot.
	KindUnplaced = "unplaced"
)

// StorageContainer is one searchable container in the world: what's in it, and
// where it stands. Player bags aren't here — they're the inventory view's
// payload, served by /inventory from the same parse.
type StorageContainer struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// ObjectID is the placed object holding it ("ItemChest_03"), which the
	// frontend turns into the name the game gives it. Empty when unplaced.
	ObjectID string     `json:"objectId"`
	Size     int        `json:"size"`
	Slots    []ItemSlot `json:"slots"`

	// The base camp and guild that own it. Both absent for world loot and
	// unplaced storage.
	BaseID  string `json:"baseId,omitempty"`
	GuildID string `json:"guildId,omitempty"`

	// Private reports that someone has put a password on this chest. The
	// password itself is never read out of the save — see the extractor's
	// read_map_object_containers.
	Private bool `json:"private,omitempty"`

	// World coordinates, in the same space the live map plots players in.
	// Nil together, for a container the save never placed.
	X *float64 `json:"x,omitempty"`
	Y *float64 `json:"y,omitempty"`
}

type Result struct {
	Players []PlayerPals `json:"players"`
	Guilds  []Guild      `json:"guilds"`
	// Storage is every non-player container in the world, fullest first.
	Storage []StorageContainer `json:"storage"`
	// ParsedAt is when the extraction ran; SaveModTime is the Level.sav
	// mtime it was parsed from — shown in the UI so "how fresh is this"
	// is never a mystery (saves only change on the game's autosave cycle).
	ParsedAt    time.Time `json:"parsedAt"`
	SaveModTime time.Time `json:"saveModTime"`
}

// maxCacheEntries bounds the parse cache (one entry per save path).
const maxCacheEntries = 8

type cacheEntry struct {
	modTime time.Time
	result  *Result
}

// Reader runs the extractor and caches results per save path, keyed on the
// save file's mtime — a Level.sav only changes when the game autosaves, so
// re-parsing (which can take seconds on a large world) is pointless until
// the mtime moves.
type Reader struct {
	scriptPath string

	// cacheMu guards the maps, so a cached read for one save never
	// waits behind another save's parse. parseMu serializes extractions:
	// each one holds the whole decompressed world in Python, so running
	// them concurrently risks memory spikes.
	cacheMu sync.Mutex
	cache   map[string]cacheEntry
	// refreshing tracks paths with a background re-parse in flight, so
	// stale serves don't stack up duplicate refresh goroutines.
	refreshing map[string]bool
	parseMu    sync.Mutex
}

// NewReader materializes the embedded extractor script into dir (the app's
// data directory) so python3 can run it.
func NewReader(dir string) (*Reader, error) {
	scriptPath := filepath.Join(dir, "extract_pals.py")
	if err := os.WriteFile(scriptPath, extractScript, 0o644); err != nil {
		return nil, fmt.Errorf("writing extractor script: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "guilds.py"), guildsModule, 0o644); err != nil {
		return nil, fmt.Errorf("writing guild decoder: %w", err)
	}
	return &Reader{scriptPath: scriptPath, cache: make(map[string]cacheEntry), refreshing: make(map[string]bool)}, nil
}

// tailLines trims a captured stderr to its last max bytes, on a line
// boundary. The tail, not the head: a Python traceback puts the actual
// exception on its final line, so truncating from the front throws away
// the only part that says what went wrong.
func tailLines(s string, max int) string {
	s = strings.TrimRight(s, "\n")
	if len(s) <= max {
		return s
	}
	s = s[len(s)-max:]
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:]
	}
	return "...\n" + s
}

// savFile resolves a configured save path to the Level.sav inside it,
// accepting either the directory that holds it or the file itself.
func savFile(savePath string) (string, error) {
	info, err := os.Stat(savePath)
	if err != nil {
		return "", fmt.Errorf("save path not accessible: %w", err)
	}
	if info.IsDir() {
		return filepath.Join(savePath, "Level.sav"), nil
	}
	return savePath, nil
}

// Read returns the parsed Pal data for the given save path, re-running the
// extractor only when Level.sav's mtime has changed since the cached parse.
func (r *Reader) Read(ctx context.Context, savePath string) (*Result, error) {
	if savePath == "" {
		return nil, ErrNotConfigured
	}
	sav, err := savFile(savePath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(sav)
	if err != nil {
		return nil, fmt.Errorf("Level.sav not accessible: %w", err)
	}

	if entry, ok := r.cachedResult(sav, info.ModTime()); ok {
		return entry, nil
	}

	// One extraction at a time overall (see parseMu). Taking the parse
	// lock can mean waiting behind another save's parse, so re-check the
	// cache after acquiring it: a queued request for the same save should
	// reuse the winner's result instead of parsing again.
	r.parseMu.Lock()
	defer r.parseMu.Unlock()

	if entry, ok := r.cachedResult(sav, info.ModTime()); ok {
		return entry, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "python3", r.scriptPath, sav)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("extractor failed: %w: %s", err, tailLines(stderr.String(), 1200))
	}

	result := &Result{ParsedAt: time.Now().UTC(), SaveModTime: info.ModTime().UTC()}
	if err := json.Unmarshal(stdout.Bytes(), result); err != nil {
		return nil, fmt.Errorf("parsing extractor output: %w", err)
	}

	r.cacheMu.Lock()
	// Each entry holds a whole parsed world (tens of MB); without a cap, a
	// deleted server or changed save path would strand its entry forever.
	// Evicting the stalest parse keeps every active server's entry warm at
	// any plausible server count.
	if _, exists := r.cache[sav]; !exists && len(r.cache) >= maxCacheEntries {
		var oldestKey string
		var oldestAt time.Time
		for k, e := range r.cache {
			if oldestKey == "" || e.result.ParsedAt.Before(oldestAt) {
				oldestKey, oldestAt = k, e.result.ParsedAt
			}
		}
		delete(r.cache, oldestKey)
	}
	r.cache[sav] = cacheEntry{modTime: info.ModTime(), result: result}
	r.cacheMu.Unlock()
	return result, nil
}

// cachedResult returns the cached parse for sav if it matches modTime.
func (r *Reader) cachedResult(sav string, modTime time.Time) (*Result, bool) {
	r.cacheMu.Lock()
	defer r.cacheMu.Unlock()
	entry, ok := r.cache[sav]
	if !ok || !entry.modTime.Equal(modTime) {
		return nil, false
	}
	return entry.result, true
}

// staleResult returns whatever parse is cached for sav, regardless of how the
// file has moved on since.
func (r *Reader) staleResult(sav string) (*Result, bool) {
	r.cacheMu.Lock()
	defer r.cacheMu.Unlock()
	entry, ok := r.cache[sav]
	if !ok {
		return nil, false
	}
	return entry.result, true
}

// ReadServeStale returns the freshest parse available without making the
// caller wait for one: an up-to-date entry is returned as-is, a stale entry
// (the save changed since it was parsed) is returned immediately while a
// re-parse runs in the background, and only a save with no cached parse at
// all blocks on the extractor. Result.SaveModTime tells the caller what
// vintage it got; a background refresh failure just leaves that standing.
func (r *Reader) ReadServeStale(ctx context.Context, savePath string) (*Result, error) {
	if savePath == "" {
		return nil, ErrNotConfigured
	}
	sav, err := savFile(savePath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(sav)
	if err != nil {
		return nil, fmt.Errorf("Level.sav not accessible: %w", err)
	}
	if entry, ok := r.cachedResult(sav, info.ModTime()); ok {
		return entry, nil
	}
	if stale, ok := r.staleResult(sav); ok {
		r.refreshAsync(savePath, sav)
		return stale, nil
	}
	return r.Read(ctx, savePath)
}

// refreshAsync re-parses savePath in the background, at most once in flight
// per save file.
func (r *Reader) refreshAsync(savePath, sav string) {
	r.cacheMu.Lock()
	if r.refreshing == nil {
		r.refreshing = make(map[string]bool)
	}
	if r.refreshing[sav] {
		r.cacheMu.Unlock()
		return
	}
	r.refreshing[sav] = true
	r.cacheMu.Unlock()

	go func() {
		// Read applies its own timeout; the requesting context would cancel
		// the refresh as soon as the stale response was written.
		_, _ = r.Read(context.Background(), savePath)
		r.cacheMu.Lock()
		delete(r.refreshing, sav)
		r.cacheMu.Unlock()
	}()
}

// writeSettle is how old a Level.sav mtime must be before Refresh will read
// it — the game writes the file in place, and parsing a half-written save
// fails (or worse, half-succeeds).
const writeSettle = 3 * time.Second

// Refresh re-parses savePath if the save has changed, so the cache is warm
// before anyone asks. Freshly written files are left to settle; a fresh cache
// entry makes it a no-op. The bool reports whether a parse was actually
// attempted, so a caller can rate-limit real work without penalizing cheap
// no-op checks. Meant for a background loop — callers serving humans want
// Read or ReadServeStale.
func (r *Reader) Refresh(ctx context.Context, savePath string) (bool, error) {
	if savePath == "" {
		return false, ErrNotConfigured
	}
	sav, err := savFile(savePath)
	if err != nil {
		return false, err
	}
	info, err := os.Stat(sav)
	if err != nil {
		return false, fmt.Errorf("Level.sav not accessible: %w", err)
	}
	if _, ok := r.cachedResult(sav, info.ModTime()); ok {
		return false, nil
	}
	if time.Since(info.ModTime()) < writeSettle {
		return false, nil
	}
	_, err = r.Read(ctx, savePath)
	return true, err
}

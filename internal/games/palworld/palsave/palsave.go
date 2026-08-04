// Package palsave reads Pal party/palbox data out of a Palworld Level.sav
// by shelling out to a bundled Python extractor built on palworld-save-tools
// (the community-standard GVAS implementation — deliberately not
// reimplemented in Go; see README "Phase 5").
//
// Read-only by design: the save file is only ever opened for reading.
//
// Only the schema below and the extractor are Palworld's. Deciding when a
// parse is stale, serving the previous one while a re-parse runs, and keeping
// concurrent extractions from stacking up is internal/savecache's job, shared
// with every other game's reader.
package palsave

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/safwyls/palcon/internal/savecache"
)

//go:embed extract_pals.py
var extractScript []byte

// extract_pals.py imports this, so both have to land in the data dir.
//
//go:embed guilds.py
var guildsModule []byte

// ErrNotConfigured is returned for servers with no save path set.
var ErrNotConfigured = savecache.ErrNotConfigured

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

	// The rest of RecordData — what this player has beaten. Zero value for a
	// save whose Players/ folder wasn't readable.
	Records Records `json:"records"`
}

// Records is one player's completion record, read from RecordData in
// Players/<uid>.sav. Everything here is per player: the save has no
// world-level "this boss is dead", only "this player has beaten it".
//
// The three flavours don't mean the same thing and shouldn't be totalled
// together. Towers and Quests are permanent. Raids and the counters only
// climb. FieldBosses is respawn state the game periodically clears (there's a
// bFieldBossDefeatFlagResetDone flag beside it), so it's "beaten since the
// last reset", not a lifetime tally.
type Records struct {
	// Towers holds BOSS_BATTLE_NAME_<x> keys; TowerCounts is keyed
	// <x>_Normal / <x>_Hard, so the same tower appears once per difficulty.
	Towers      []string       `json:"towers"`
	TowerCounts map[string]int `json:"towerCounts"`
	// Raids is keyed PalSummon_<pal id>, counting summons defeated.
	Raids map[string]int `json:"raids"`
	// FieldBosses mixes field alphas with the human bounty targets; only
	// some keys resolve to a name, the rest are opaque spawner ids.
	FieldBosses []string `json:"fieldBosses"`
	// NpcRewards is the game's own achievement tiers: PalDex_1..10 etc.
	NpcRewards []string `json:"npcRewards"`
	Quests     []string `json:"quests"`

	// Exploration counters. These are raw totals with no known denominator —
	// FastTravel counts more map points than there are fast-travel statues,
	// so don't render any of them as a percentage.
	FastTravel int `json:"fastTravel"`
	Areas      int `json:"areas"`
	Relics     int `json:"relics"`
	// EffigyTypes counts picked-up effigies per kind, keyed CapturePower and
	// friends. Relics is their sum.
	EffigyTypes map[string]int `json:"effigyTypes"`
	Notes       int            `json:"notes"`

	CampsConquered       int `json:"campsConquered"`
	DungeonsCleared      int `json:"dungeonsCleared"`
	FixedDungeonsCleared int `json:"fixedDungeonsCleared"`
	TreasuresFound       int `json:"treasuresFound"`
	TribesCaptured       int `json:"tribesCaptured"`
	Mutations            int `json:"mutations"`
	BossTechPoints       int `json:"bossTechPoints"`

	// ArenaRanks is the solo arena ladder, keyed Bronze..Master; the highest
	// present is the rank a player holds.
	ArenaRanks map[string]int `json:"arenaRanks"`
	// RelicRanks is the effigy rank per bonus, keyed CapturePower and
	// friends. The movement/utility bonuses duplicate what the inventory
	// view shows as adventure stats; capture power is unique to this map.
	RelicRanks        map[string]int `json:"relicRanks"`
	PredatorsDefeated int            `json:"predatorsDefeated"`
	OilrigsCleared    int            `json:"oilrigsCleared"`
	Awakenings        int            `json:"awakenings"`
	// GameCleared is the game's own story-finished flag. False in saves from
	// before it existed, which reads the same as not finished.
	GameCleared bool `json:"gameCleared"`
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

// extractor is the savecache Source for Palworld: where Level.sav is, and
// how to turn it into a Result.
type extractor struct{ scriptPath string }

// Locate accepts either the directory holding Level.sav or the file itself.
func (e extractor) Locate(savePath string) (string, error) {
	info, err := os.Stat(savePath)
	if err != nil {
		return "", fmt.Errorf("save path not accessible: %w", err)
	}
	if info.IsDir() {
		return filepath.Join(savePath, "Level.sav"), nil
	}
	return savePath, nil
}

func (e extractor) Parse(ctx context.Context, file string, modTime time.Time) (*Result, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "python3", e.scriptPath, file)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("extractor failed: %w: %s", err, tailLines(stderr.String(), 1200))
	}

	result := &Result{ParsedAt: time.Now().UTC(), SaveModTime: modTime.UTC()}
	if err := json.Unmarshal(stdout.Bytes(), result); err != nil {
		return nil, fmt.Errorf("parsing extractor output: %w", err)
	}
	return result, nil
}

// Reader runs the extractor behind a shared parse cache. See internal/savecache
// for the freshness, single-flight and stale-serve behaviour it inherits.
type Reader struct {
	cache *savecache.Cache[Result]
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
	return newReader(scriptPath), nil
}

func newReader(scriptPath string) *Reader {
	return &Reader{cache: savecache.New[Result](extractor{scriptPath: scriptPath})}
}

// Read returns the parsed Pal data for the given save path, re-running the
// extractor only when Level.sav's mtime has changed since the cached parse.
func (r *Reader) Read(ctx context.Context, savePath string) (*Result, error) {
	return r.cache.Read(ctx, savePath)
}

// ReadServeStale returns the freshest parse available without making the
// caller wait for one. Result.SaveModTime tells the caller what vintage it got.
func (r *Reader) ReadServeStale(ctx context.Context, savePath string) (*Result, error) {
	return r.cache.ReadServeStale(ctx, savePath)
}

// Refresh re-parses savePath if the save has changed, so the cache is warm
// before anyone asks. The bool reports whether a parse was actually attempted.
// Meant for a background loop — callers serving humans want Read or
// ReadServeStale.
func (r *Reader) Refresh(ctx context.Context, savePath string) (bool, error) {
	return r.cache.Refresh(ctx, savePath)
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

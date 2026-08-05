package game

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// DefaultID is the game assumed for rows written before palcon knew there
// was more than one, and the default for a server created without saying.
const DefaultID = "palworld"

// Definition is everything the shared layer needs to know about one game:
// how to talk to it, how to spell a player id, and which dashboard views it
// can fill.
//
// Keep this to what shared code actually consumes. Anything only one game's
// own package uses belongs in that package, not here — a Definition field
// with a single reader is a coupling with no payoff, and one with no reader
// is a promise nothing keeps. Facts that used to live here and lost their
// readers moved to their consumers: the Steam app id is palworld.AppID (and
// palagent's DefaultAppID, agreement test-enforced), and save staleness is
// the savecache Source's Locate.
type Definition struct {
	// ID is the stable key stored on the servers row ("palworld", "ark").
	ID string
	// Name is the human label ("Palworld").
	Name string

	// DefaultGamePort repairs a row created or edited without a game port —
	// see store's normalizeGamePort. (The provisioning wizard doesn't read
	// it: provisioning is Palworld-only and says so in its own numbers.)
	DefaultGamePort int

	// NewClient builds an admin client for a server of this game.
	NewClient func(Conn) Client

	// CanonicalUID renders a live player id in the spelling the game's save
	// files use, so an id from any transport can be matched against save
	// data. Nil means the id needs no normalization.
	//
	// This exists because getting it wrong fails silently: a mismatched id
	// simply never matches, which for a visibility check means failing open.
	CanonicalUID func(string) string

	// Features are the dashboard views this game can fill, in nav order,
	// from the FeatureX constants. A view whose feature is absent is never
	// offered — that is how a game without, say, a creature collection
	// avoids shipping an empty Paldex tab.
	Features []string
}

// Feature keys. These name dashboard views, not game concepts, so a second
// game reuses the ones that fit rather than inventing synonyms: ARK's tames
// are Pals, its tribes are Guilds, its dino dex is Paldex.
//
// They live here rather than in the store because which of them exist at all
// is a property of the game, and the store only ever encodes and decodes the
// subset an admin has switched off.
const (
	FeatureMap          = "map"
	FeaturePals         = "pals"
	FeatureInventory    = "inventory"
	FeatureStorage      = "storage"
	FeaturePaldex       = "paldex"
	FeatureAchievements = "achievements"
	FeatureGuilds       = "guilds"
	FeatureCalculators  = "calculators"
)

var (
	mu       sync.RWMutex
	registry = map[string]*Definition{}
)

// Register makes a game available. Implementations call it from an init
// function, and the internal/games package blank-imports every one so a
// single import wires them all up.
//
// It panics on a missing id, a missing NewClient, or a duplicate
// registration: all three are programmer errors that would otherwise surface
// much later as an unreachable server.
func Register(def *Definition) {
	if def == nil || def.ID == "" {
		panic("game.Register: definition with no ID")
	}
	if def.NewClient == nil {
		panic("game.Register: " + def.ID + " has no NewClient")
	}
	mu.Lock()
	defer mu.Unlock()
	if _, dup := registry[def.ID]; dup {
		panic("game.Register: duplicate registration for " + def.ID)
	}
	registry[def.ID] = def
}

// Get returns the definition for id. An empty id means DefaultID, so rows
// written before the game column existed keep working.
func Get(id string) (*Definition, bool) {
	if id == "" {
		id = DefaultID
	}
	mu.RLock()
	defer mu.RUnlock()
	def, ok := registry[id]
	return def, ok
}

// All returns every registered definition, ordered by name.
func All() []*Definition {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]*Definition, 0, len(registry))
	for _, d := range registry {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// featureOrder is the canonical nav order, and the floor for AllFeatures.
var featureOrder = []string{
	FeatureMap, FeaturePals, FeatureInventory, FeatureStorage,
	FeaturePaldex, FeatureAchievements, FeatureGuilds, FeatureCalculators,
}

// AllFeatures is the validation set for stored view-visibility switches: the
// canonical list, plus any key a registered game adds.
//
// Deliberately *not* narrowed to what's currently registered. This set decides
// which stored keys survive a round trip, and the two ways to be wrong are not
// symmetric: keeping a key no game offers costs nothing (it simply never
// renders — that's Definition.Features' job), while dropping one silently
// erases a switch an admin set. An empty registry must therefore still
// validate the full list rather than wipe every stored preference.
func AllFeatures() []string {
	out := append([]string(nil), featureOrder...)
	extra := make([]string, 0)
	for _, d := range All() {
		for _, f := range d.Features {
			if !contains(out, f) && !contains(extra, f) {
				extra = append(extra, f)
			}
		}
	}
	sort.Strings(extra)
	return append(out, extra...)
}

// HasFeature reports whether this game offers a view.
func (d *Definition) HasFeature(feature string) bool { return contains(d.Features, feature) }

// UnknownGameError is a server row naming a game this build doesn't have —
// a downgrade, or a row hand-edited into a typo.
type UnknownGameError struct{ ID string }

func (e *UnknownGameError) Error() string {
	known := make([]string, 0)
	for _, d := range All() {
		known = append(known, d.ID)
	}
	if len(known) == 0 {
		return fmt.Sprintf("unknown game %q: no games are registered", e.ID)
	}
	return fmt.Sprintf("unknown game %q (known: %s)", e.ID, strings.Join(known, ", "))
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/safwyls/palcon/internal/agentfiles"
	"github.com/safwyls/palcon/internal/games/palworld/palsave"
	"github.com/safwyls/palcon/internal/store"
)

// readSaveForRequest resolves the {serverID} route param and returns the
// parsed save data for that server alongside the server itself, writing the
// error response and returning ok=false on any failure. 400 with a distinct
// message when the server has no save path configured, so the frontend can
// show setup guidance instead of an error.
//
// features are the views this endpoint's payload backs; the read is refused
// only when every one of them is switched off.
func (s *Server) readSaveForRequest(w http.ResponseWriter, r *http.Request, features ...string) (*palsave.Result, *store.Server, bool) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return nil, nil, false
	}
	if !requireFeature(w, r, srv, features...) {
		return nil, nil, false
	}
	savePath, err := s.files.SavePath(r.Context(), srv)
	if errors.Is(err, agentfiles.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no save path configured")
		return nil, nil, false
	}
	if err != nil {
		s.logger.Error("save sync from agent failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return nil, nil, false
	}
	// Serve-stale: a save that changed since the last parse returns the old
	// parse immediately (with its SaveModTime telling on itself) while a
	// re-parse runs in the background; only a never-parsed save blocks.
	result, err := s.palReader.ReadServeStale(r.Context(), savePath)
	if errors.Is(err, palsave.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no save path configured")
		return nil, nil, false
	}
	if err != nil {
		s.logger.Error("save extraction failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return nil, nil, false
	}
	return result, srv, true
}

// handleServerPals serves the phase 5 Pal viewer: party/palbox/base pals
// per player, parsed from the server's Level.sav (read-only).
func (s *Server) handleServerPals(w http.ResponseWriter, r *http.Request) {
	// One payload, three views: Player pals, Paldex and Calculators all read
	// it, so it answers while any of them is on.
	result, srv, ok := s.readSaveForRequest(w, r, store.FeaturePals, store.FeaturePaldex, store.FeatureCalculators)
	if !ok {
		return
	}
	hidden, err := s.hiddenPlayers(r, srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"players":     toPalsPlayers(visiblePlayers(result.Players, hidden, store.StreamPals), s.lastSeen(r, srv)),
		"guilds":      result.Guilds,
		"parsedAt":    result.ParsedAt,
		"saveModTime": result.SaveModTime,
	})
}

// lastSeenIndex is when the collector last watched each of a server's
// players. The collector writes canonical uids, so lookups by a save's uid go
// through the same spelling — carried here rather than passed around, because
// a missed normalization fails silently as "never seen" rather than erroring.
type lastSeenIndex struct {
	at    map[string]time.Time
	canon func(string) string
}

// Unix is a player's observed last-seen, in the unix seconds the save's own
// timestamps use. Zero means palcon never watched this player leave — a
// server it has not collected for yet, or history predating the uid column —
// and the views treat zero as "fall back to the save".
func (i lastSeenIndex) Unix(uid string) int64 {
	if i.canon != nil {
		uid = i.canon(uid)
	}
	at, ok := i.at[uid]
	if !ok || at.IsZero() {
		return 0
	}
	return at.Unix()
}

// lastSeen reads the collector's history for this server. An empty index on
// failure rather than an error: it decorates a payload that is worth serving
// without it, and the views fall back to the save's own login stamp.
func (s *Server) lastSeen(r *http.Request, srv *store.Server) lastSeenIndex {
	idx := lastSeenIndex{canon: srv.CanonicalUID}
	seen, err := s.store.LastSeen(r.Context(), srv.ID)
	if err != nil {
		s.logger.Error("reading last-seen history", "server", srv.ID, "error", err)
		return idx
	}
	idx.at = seen
	return idx
}

// visiblePlayers drops the players withheld from this stream. Returns the
// input untouched when nothing is hidden, which is the usual case.
func visiblePlayers(players []palsave.PlayerPals, hidden store.PlayerVisibility, stream string) []palsave.PlayerPals {
	if len(hidden) == 0 {
		return players
	}
	out := make([]palsave.PlayerPals, 0, len(players))
	for _, p := range players {
		if !hidden.HiddenFor(p.UID, stream) {
			out = append(out, p)
		}
	}
	return out
}

// palsPlayer is what /pals and /guilds serve for each player.
//
// Spelled out rather than serving palsave.PlayerPals directly, and that is the
// whole point: PlayerPals is the extractor's struct, and everything added to it
// used to appear on these two endpoints for free. Inventory and Character did
// exactly that — the Inventory view was gated and its player-level hides were
// honoured, while the same bytes stayed one fetch away on /pals. Adding a field
// here has to be a decision now, not a side effect. TestPalsPayloadFields
// fails if this drifts.
//
// json:"-" wouldn't have worked: the same struct is unmarshalled *from* the
// extractor, so hiding a field from the response hides it from the parse too.
//
// LastOnline and LastSeen are not two spellings of one thing. LastOnline is
// the save's own LastOnlineDateTime, which Palworld writes when a player
// *connects* and never updates — so for anyone offline it says when they
// arrived, not when they left. LastSeen is palcon's own observation of them
// leaving, and is 0 when it has none. Views wanting "last seen" want LastSeen
// with LastOnline only as a labelled fallback.
type palsPlayer struct {
	UID              string         `json:"uid"`
	Nickname         string         `json:"nickname"`
	Level            int            `json:"level"`
	Party            []palsave.Pal  `json:"party"`
	Palbox           []palsave.Pal  `json:"palbox"`
	Base             []palsave.Pal  `json:"base"`
	Storage          []palsave.Pal  `json:"storage"`
	LastOnline       int64          `json:"lastOnline"`
	LastSeen         int64          `json:"lastSeen"`
	LastX            *float64       `json:"lastX"`
	LastY            *float64       `json:"lastY"`
	Platform         string         `json:"platform"`
	TechnologyPoints int            `json:"technologyPoints"`
	Paldeck          []string       `json:"paldeck"`
	Captures         map[string]int `json:"captures"`
}

func toPalsPlayers(players []palsave.PlayerPals, seen lastSeenIndex) []palsPlayer {
	out := make([]palsPlayer, 0, len(players))
	for _, p := range players {
		out = append(out, palsPlayer{
			UID:              p.UID,
			Nickname:         p.Nickname,
			Level:            p.Level,
			Party:            p.Party,
			Palbox:           p.Palbox,
			Base:             p.Base,
			Storage:          p.Storage,
			LastOnline:       p.LastOnline,
			LastSeen:         seen.Unix(p.UID),
			LastX:            p.LastX,
			LastY:            p.LastY,
			Platform:         p.Platform,
			TechnologyPoints: p.TechnologyPoints,
			Paldeck:          p.Paldeck,
			Captures:         p.Captures,
		})
	}
	return out
}

// inventoryPlayer is the /inventory projection of a player: who they are, plus
// their bags. Deliberately not the whole PlayerPals — the pals payload runs to
// tens of MB on a large world, and none of it is on screen here.
type inventoryPlayer struct {
	UID       string             `json:"uid"`
	Nickname  string             `json:"nickname"`
	Level     int                `json:"level"`
	Inventory palsave.Inventory  `json:"inventory"`
	Character *palsave.Character `json:"character,omitempty"`
	// Unix seconds, both, and 0 when unknown. Enough to caption the sheet
	// with how stale a look at this player is — see palsPlayer for why the
	// save's own stamp is a login time and not a last-seen one.
	LastOnline int64  `json:"lastOnline"`
	LastSeen   int64  `json:"lastSeen"`
	Platform   string `json:"platform"`
}

// handleServerInventory serves the item viewer: every player's containers,
// parsed from the server's Level.sav (read-only). Backed by the same cached
// save read as /pals and /guilds, so opening any of them costs one parse.
func (s *Server) handleServerInventory(w http.ResponseWriter, r *http.Request) {
	result, srv, ok := s.readSaveForRequest(w, r, store.FeatureInventory)
	if !ok {
		return
	}
	hidden, err := s.hiddenPlayers(r, srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seen := s.lastSeen(r, srv)
	players := make([]inventoryPlayer, 0, len(result.Players))
	for _, p := range visiblePlayers(result.Players, hidden, store.StreamInventory) {
		// A player with no containers at all has nothing to show; skipping
		// them keeps the page from listing empty sections for characters
		// that only exist as a guild membership.
		if len(p.Inventory) == 0 {
			continue
		}
		players = append(players, inventoryPlayer{
			UID:        p.UID,
			Nickname:   p.Nickname,
			Level:      p.Level,
			Inventory:  p.Inventory,
			Character:  p.Character,
			LastOnline: p.LastOnline,
			LastSeen:   seen.Unix(p.UID),
			Platform:   p.Platform,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"players":     players,
		"parsedAt":    result.ParsedAt,
		"saveModTime": result.SaveModTime,
	})
}

// achievementsPlayer is the /achievements projection: who a player is, plus
// what they've beaten. Its own projection rather than a field on palsPlayer
// because the pals payload carries every pal on the server and runs to tens of
// MB, and this page needs a few KB of it.
type achievementsPlayer struct {
	UID      string          `json:"uid"`
	Nickname string          `json:"nickname"`
	Level    int             `json:"level"`
	Records  palsave.Records `json:"records"`
	// Enough to caption how stale a player's record is — see palsPlayer for
	// why the save's own stamp is a login time and not a last-seen one.
	LastOnline int64 `json:"lastOnline"`
	LastSeen   int64 `json:"lastSeen"`
}

// handleServerAchievements serves the completion view: per-player tower, raid,
// boss and quest records from the save's Players/*.sav files. Backed by the
// same cached save read as /pals and /inventory, so opening any of them costs
// one parse.
//
// Gated on the pals stream, not one of its own: the records live in the same
// player files the pals view reads, so a player hidden from that payload has
// asked not to be enumerated from it.
func (s *Server) handleServerAchievements(w http.ResponseWriter, r *http.Request) {
	result, srv, ok := s.readSaveForRequest(w, r, store.FeatureAchievements)
	if !ok {
		return
	}
	hidden, err := s.hiddenPlayers(r, srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	seen := s.lastSeen(r, srv)
	players := make([]achievementsPlayer, 0, len(result.Players))
	for _, p := range visiblePlayers(result.Players, hidden, store.StreamPals) {
		players = append(players, achievementsPlayer{
			UID:        p.UID,
			Nickname:   p.Nickname,
			Level:      p.Level,
			Records:    p.Records,
			LastOnline: p.LastOnline,
			LastSeen:   seen.Unix(p.UID),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"players":     players,
		"parsedAt":    result.ParsedAt,
		"saveModTime": result.SaveModTime,
	})
}

// storageBase is a base camp the storage view groups containers under. Named
// by its guild because a camp's own name in the save is an internal
// placeholder — see parse_base_camps in the extractor.
//
// This much guild identity rides along regardless of the guilds view's own
// switch: without it a base camp is a bare pair of coordinates, and the view
// stops making sense. It is deliberately less than /guilds serves — no member
// roster, no pal totals.
type storageBase struct {
	ID        string `json:"id"`
	GuildID   string `json:"guildId"`
	GuildName string `json:"guildName"`
	// Index is the camp's position in its guild's base list, which is what
	// names its marker on the map — so a container here can link straight to
	// the pin the map already draws for it.
	Index int     `json:"index"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

// storageFor picks the containers a request should see.
//
// Both exclusions are applied here rather than in the browser, so "off" means
// the contents never leave the process instead of the page receiving them and
// choosing not to draw them. They're switched by different people, though:
// world loot is the reader's own choice per request, while private chests are
// an admin's standing decision for the whole server.
func storageFor(all []palsave.StorageContainer, world, private bool) []palsave.StorageContainer {
	out := make([]palsave.StorageContainer, 0, len(all))
	for _, c := range all {
		if c.Kind == palsave.KindWorld && !world {
			continue
		}
		if c.Private && !private {
			continue
		}
		out = append(out, c)
	}
	return out
}

// storageGuild names a guild for the storage view — enough to label its guild
// chest, and deliberately nothing more.
type storageGuild struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// handleServerStorage serves the storage search: every non-player container in
// the world, with the base camp each one stands at.
//
// World loot (the treasure boxes scattered across the map) is left out unless
// ?world=1 asks for it. It's roughly nine tenths of both the container count
// and the payload, and a search for "where is our cement" should not have to
// wade through four thousand map chests to answer — nor should opening the
// page hand someone the location of every unopened chest on the server.
func (s *Server) handleServerStorage(w http.ResponseWriter, r *http.Request) {
	// No per-player visibility pass: a chest belongs to a base camp, not to
	// the player who happened to place it, and the payload carries no uid.
	result, srv, ok := s.readSaveForRequest(w, r, store.FeatureStorage)
	if !ok {
		return
	}
	world := r.URL.Query().Get("world") == "1"
	// The admin's switch decides whether locked chests are indexed at all;
	// the reader's "exclude private" checkbox is a view filter on top of what
	// this serves, since fifteen chests aren't worth a second round trip.
	private := !srv.HidePrivateStorage
	containers := storageFor(result.Storage, world, private)

	bases := make([]storageBase, 0)
	// Guilds ride along separately from their bases: the guild chest belongs to
	// a guild without standing at any camp, so a guild with no base at all
	// would otherwise have nothing to name it by.
	guilds := make([]storageGuild, 0, len(result.Guilds))
	for _, g := range result.Guilds {
		guilds = append(guilds, storageGuild{ID: g.ID, Name: g.Name})
		for i, b := range g.Bases {
			bases = append(bases, storageBase{ID: b.ID, GuildID: g.ID, GuildName: g.Name, Index: i, X: b.X, Y: b.Y})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"containers": containers,
		"bases":      bases,
		"guilds":     guilds,
		// So the page can say what it is and isn't showing rather than
		// implying the world holds only what's on screen.
		"includesWorld":   world,
		"includesPrivate": private,
		"parsedAt":        result.ParsedAt,
		"saveModTime":     result.SaveModTime,
	})
}

// handleServerGuilds serves the guild view. Backed by the same cached save
// read as /pals, so opening both costs one parse.
//
// The live map reads this too — it's where offline players' last-known
// positions and the guild base coordinates come from — so it answers while
// either view is on.
func (s *Server) handleServerGuilds(w http.ResponseWriter, r *http.Request) {
	result, srv, ok := s.readSaveForRequest(w, r, store.FeatureGuilds, store.FeatureMap)
	if !ok {
		return
	}
	hidden, err := s.hiddenPlayers(r, srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Two different hides land on one payload: a player withheld from pals
	// drops out entirely (and out of their guild's rollups with them), while
	// one withheld from the map keeps their guild standing but loses the
	// last-known position, which is the only part the map plots.
	players := withoutPositions(visiblePlayers(result.Players, hidden, store.StreamPals), hidden)
	writeJSON(w, http.StatusOK, map[string]any{
		"guilds":      result.Guilds,
		"players":     toPalsPlayers(players, s.lastSeen(r, srv)),
		"parsedAt":    result.ParsedAt,
		"saveModTime": result.SaveModTime,
	})
}

// withoutPositions blanks the last-known coordinates of players withheld from
// the map stream.
//
// Copies before writing: the slice it's given belongs to the reader's parse
// cache, which is shared by every request for this save, so editing in place
// would hide the player from everyone until the save changed.
func withoutPositions(players []palsave.PlayerPals, hidden store.PlayerVisibility) []palsave.PlayerPals {
	any := false
	for _, p := range players {
		if hidden.HiddenFor(p.UID, store.StreamMap) {
			any = true
			break
		}
	}
	if !any {
		return players
	}
	out := make([]palsave.PlayerPals, len(players))
	copy(out, players)
	for i := range out {
		if hidden.HiddenFor(out[i].UID, store.StreamMap) {
			out[i].LastX, out[i].LastY = nil, nil
		}
	}
	return out
}

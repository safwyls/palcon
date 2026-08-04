package api

import (
	"encoding/json"
	"net/http"

	"github.com/safwyls/palcon/internal/store"
)

// Visibility is two switches on the same data.
//
// A *feature* is a view an admin can switch off for a server, which stops the
// endpoints behind it from answering and drops its link from the nav. A
// *stream* is a single player opting out of one kind of data, which filters
// them out of payloads the view still serves for everyone else.
//
// Admins bypass both. The point is letting a server owner honour a privacy
// request without also blinding themselves for moderation — and an admin who
// wants the strict version can turn the view off and leave it off, since they
// are the only ones who can turn it back on.

// canSee reports whether this request may see the given feature.
func canSee(r *http.Request, srv *store.Server, feature string) bool {
	if user, ok := userFromContext(r.Context()); ok && user.IsAdmin() {
		return true
	}
	return !store.Hidden(srv.HiddenFeatures, feature)
}

// canSeeAny reports whether any of the features is visible. Used where one
// payload backs several views: /pals answers the Player pals, Paldex and
// Calculators pages, so it stays available while any of them is on.
func canSeeAny(r *http.Request, srv *store.Server, features ...string) bool {
	for _, f := range features {
		if canSee(r, srv, f) {
			return true
		}
	}
	return false
}

// requireFeature writes the 403 and reports false when the view is off. The
// message names the view rather than the endpoint, because what the reader
// needs to know is "an admin turned this off", not which route refused.
func requireFeature(w http.ResponseWriter, r *http.Request, srv *store.Server, features ...string) bool {
	if canSeeAny(r, srv, features...) {
		return true
	}
	writeError(w, http.StatusForbidden, "this view is turned off for this server")
	return false
}

// hiddenPlayers returns the per-player opt-outs that apply to this request —
// empty for an admin, who sees everyone.
func (s *Server) hiddenPlayers(r *http.Request, serverID int64) (store.PlayerVisibility, error) {
	if user, ok := userFromContext(r.Context()); ok && user.IsAdmin() {
		return store.PlayerVisibility{}, nil
	}
	return s.store.ListPlayerVisibility(r.Context(), serverID)
}

// rosterEntry names a player the admin can hide. Just enough to list them.
type rosterEntry struct {
	UID      string `json:"uid"`
	Nickname string `json:"nickname"`
	Level    int    `json:"level"`
}

type visibilityPayload struct {
	// Views switched off for everyone but admins.
	HiddenFeatures []string `json:"hiddenFeatures"`
	// Whether the Storage view may search password-locked chests. Not a
	// view switch: it takes a category of container out of the index for
	// everyone including admins, so it lives beside them rather than in
	// them. See the 0018 migration for why admins don't bypass it.
	HidePrivateStorage bool `json:"hidePrivateStorage"`
	// player uid -> streams that player is withheld from.
	Players map[string][]string `json:"players"`
	// Everyone in the save, so the UI has a list to put switches against.
	// Empty when the server has no readable save — say so rather than
	// presenting an empty table as "no players".
	Roster []rosterEntry `json:"roster"`
	// True when the roster is empty because the save couldn't be read, as
	// opposed to a world with nobody in it.
	RosterUnavailable bool `json:"rosterUnavailable"`
	// The keys the UI is allowed to send, so it never has to hardcode them.
	AllFeatures []string `json:"allFeatures"`
	AllStreams  []string `json:"allStreams"`
}

// handleServerVisibility serves the current switches. Admin-only: it lists who
// has asked to be hidden, which is itself information the hiding is meant to
// keep quiet.
func (s *Server) handleServerVisibility(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	players, err := s.store.ListPlayerVisibility(r.Context(), srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	roster, rosterErr := s.roster(r, srv)
	if rosterErr != nil {
		// A save that can't be read costs the per-player table, not the whole
		// page: the view switches above it still work and still matter.
		s.logger.Warn("visibility roster unavailable", "server", srv.ID, "error", rosterErr)
	}
	writeJSON(w, http.StatusOK, visibilityPayload{
		HiddenFeatures:     srv.HiddenFeatures,
		HidePrivateStorage: srv.HidePrivateStorage,
		Players:            players,
		Roster:             roster,
		RosterUnavailable:  rosterErr != nil,
		AllFeatures:        srv.Features(),
		AllStreams:         store.AllStreams,
	})
}

// roster lists everyone in the server's save, for the per-player table.
func (s *Server) roster(r *http.Request, srv *store.Server) ([]rosterEntry, error) {
	savePath, err := s.files.SavePath(r.Context(), srv)
	if err != nil {
		return nil, err
	}
	result, err := s.palReader.ReadServeStale(r.Context(), savePath)
	if err != nil {
		return nil, err
	}
	out := make([]rosterEntry, 0, len(result.Players))
	for _, p := range result.Players {
		out = append(out, rosterEntry{UID: p.UID, Nickname: p.Nickname, Level: p.Level})
	}
	return out, nil
}

// handleUpdateServerVisibility replaces the switches. The whole state is sent
// each time rather than patched, so two admins editing at once can't merge
// into a combination neither of them chose.
func (s *Server) handleUpdateServerVisibility(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	var req struct {
		HiddenFeatures     []string            `json:"hiddenFeatures"`
		HidePrivateStorage bool                `json:"hidePrivateStorage"`
		Players            map[string][]string `json:"players"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.store.SetHiddenFeatures(r.Context(), srv.ID, req.HiddenFeatures); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.SetHidePrivateStorage(r.Context(), srv.ID, req.HidePrivateStorage); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Existing rows not named in the request are cleared: the payload is the
	// full state, so an omitted player is one nobody is hiding any more.
	existing, err := s.store.ListPlayerVisibility(r.Context(), srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for uid := range existing {
		if _, still := req.Players[uid]; !still {
			if err := s.store.SetPlayerVisibility(r.Context(), srv.ID, uid, nil); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
	}
	for uid, streams := range req.Players {
		if err := s.store.SetPlayerVisibility(r.Context(), srv.ID, uid, streams); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}
	s.audit(r, srv.ID, "server.visibility", "updated view and player visibility")
	w.WriteHeader(http.StatusNoContent)
}

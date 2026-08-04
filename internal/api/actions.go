package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/safwyls/palcon/internal/game"
	"github.com/safwyls/palcon/internal/store"
)

var errBadServerID = errors.New("invalid server id")

func (s *Server) clientForServerID(r *http.Request) (game.Client, *store.Server, error) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		return nil, nil, errBadServerID
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err != nil {
		return nil, nil, err
	}
	client, err := srv.Client()
	if err != nil {
		return nil, nil, err
	}
	return client, srv, nil
}

// writeServerLoadError maps a clientForServerID failure onto the right
// status: bad path segment → 400, missing row → 404, a row naming a game
// this build doesn't have → 501, and anything else is a real store/DB
// failure → 500 (not a client error).
func writeServerLoadError(w http.ResponseWriter, err error) {
	var unknownGame *game.UnknownGameError
	switch {
	case errors.Is(err, errBadServerID):
		writeError(w, http.StatusBadRequest, "invalid server id")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "server not found")
	case errors.As(err, &unknownGame):
		writeError(w, http.StatusNotImplemented, unknownGame.Error())
	default:
		writeError(w, http.StatusInternalServerError, "failed to load server")
	}
}

// withClient runs fn against the server's client, reporting success so
// callers can audit actions that actually happened.
func (s *Server) withClient(w http.ResponseWriter, r *http.Request, fn func(game.Client) error) bool {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeServerLoadError(w, err)
		return false
	}
	if err := fn(client); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return false
	}
	w.WriteHeader(http.StatusNoContent)
	return true
}

// serverIDOf is the path's server id, for audit rows; 0 only on a malformed
// path, which no successful action can have had.
func serverIDOf(r *http.Request) int64 {
	id, _ := serverIDFromRequest(r)
	return id
}

func (s *Server) handleServerInfo(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeServerLoadError(w, err)
		return
	}
	info, err := client.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleServerPlayers(w http.ResponseWriter, r *http.Request) {
	client, srv, err := s.clientForServerID(r)
	if err != nil {
		writeServerLoadError(w, err)
		return
	}
	players, err := client.Players(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	// Not gated on the map feature: the dashboard's online list reads this
	// too, and a name and level aren't the private part. The coordinates are,
	// so those go when the map is off or the player has opted out of it.
	if !canSee(r, srv, store.FeatureMap) {
		for i := range players {
			players[i].LocationX, players[i].LocationY = 0, 0
		}
	} else if hidden, err := s.hiddenPlayers(r, srv.ID); err == nil && len(hidden) > 0 {
		for i := range players {
			if hidden.HiddenFor(srv.CanonicalUID(players[i].PlayerUID), store.StreamMap) {
				players[i].LocationX, players[i].LocationY = 0, 0
			}
		}
	}
	writeJSON(w, http.StatusOK, players)
}

func (s *Server) handleServerBroadcast(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if s.withClient(w, r, func(c game.Client) error {
		return c.Broadcast(r.Context(), req.Message)
	}) {
		s.audit(r, serverIDOf(r), "broadcast", req.Message)
	}
}

func (s *Server) handleServerKick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if s.withClient(w, r, func(c game.Client) error {
		return c.Kick(r.Context(), req.PlayerUID, req.Message)
	}) {
		s.audit(r, serverIDOf(r), "kick", req.PlayerUID)
	}
}

func (s *Server) handleServerBan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if s.withClient(w, r, func(c game.Client) error {
		return c.Ban(r.Context(), req.PlayerUID, req.Message)
	}) {
		s.audit(r, serverIDOf(r), "ban", req.PlayerUID)
	}
}

func (s *Server) handleServerUnban(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if s.withClient(w, r, func(c game.Client) error {
		return c.Unban(r.Context(), req.PlayerUID)
	}) {
		s.audit(r, serverIDOf(r), "unban", req.PlayerUID)
	}
}

func (s *Server) handleServerSave(w http.ResponseWriter, r *http.Request) {
	if s.withClient(w, r, func(c game.Client) error {
		return c.Save(r.Context())
	}) {
		s.audit(r, serverIDOf(r), "save-world", "")
	}
}

func (s *Server) handleServerShutdown(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WaitSeconds int    `json:"waitSeconds"`
		Message     string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if s.withClient(w, r, func(c game.Client) error {
		return c.Shutdown(r.Context(), req.WaitSeconds, req.Message)
	}) {
		s.audit(r, serverIDOf(r), "shutdown", fmt.Sprintf("in %ds: %s", req.WaitSeconds, req.Message))
	}
}

func (s *Server) handleServerSettings(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeServerLoadError(w, err)
		return
	}
	ext, ok := client.(game.ExtendedClient)
	if !ok {
		writeError(w, http.StatusBadRequest, "this server is configured RCON-only; settings require the REST API")
		return
	}
	settings, err := ext.Settings(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) handleServerMetrics(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeServerLoadError(w, err)
		return
	}
	ext, ok := client.(game.ExtendedClient)
	if !ok {
		writeError(w, http.StatusBadRequest, "this server is configured RCON-only; metrics require the REST API")
		return
	}
	metrics, err := ext.Metrics(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, metrics)
}

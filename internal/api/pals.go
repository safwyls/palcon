package api

import (
	"errors"
	"net/http"

	"github.com/safwyls/palcon/internal/palsave"
	"github.com/safwyls/palcon/internal/store"
)

// handleServerPals serves the phase 5 Pal viewer: party/palbox/base pals per
// player, parsed from the server's Level.sav (read-only). 400 with a
// distinct message when the server has no save path configured, so the
// frontend can show setup guidance instead of an error.
func (s *Server) handleServerPals(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load server")
		return
	}

	result, err := s.palReader.Read(r.Context(), srv.SavePath)
	if errors.Is(err, palsave.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no save path configured")
		return
	}
	if err != nil {
		s.logger.Error("pal extraction failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// handleServerGuilds serves the guild view. Backed by the same cached save
// read as /pals, so opening both costs one parse.
func (s *Server) handleServerGuilds(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load server")
		return
	}

	result, err := s.palReader.Read(r.Context(), srv.SavePath)
	if errors.Is(err, palsave.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no save path configured")
		return
	}
	if err != nil {
		s.logger.Error("guild extraction failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"guilds":      result.Guilds,
		"players":     result.Players,
		"parsedAt":    result.ParsedAt,
		"saveModTime": result.SaveModTime,
	})
}

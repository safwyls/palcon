package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/safwyls/palcon/internal/agentfiles"
	"github.com/safwyls/palcon/internal/games/palworld/palconfig"
	"github.com/safwyls/palcon/internal/store"
)

// resolveConfigPath yields the local directory palconfig operates on: the
// configured mount, or a fresh copy pulled from the server's agent. When
// viaAgent, edits must be pushed back with s.files.PushConfig. Errors are
// written to w; ok=false means the response is already sent.
func (s *Server) resolveConfigPath(w http.ResponseWriter, r *http.Request, srv *store.Server) (path string, viaAgent, ok bool) {
	path, viaAgent, err := s.files.ConfigPath(r.Context(), srv)
	if errors.Is(err, agentfiles.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no config path configured")
		return "", false, false
	}
	if err != nil {
		s.logger.Error("fetching config from agent failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return "", false, false
	}
	return path, viaAgent, true
}

// handleGetConfig returns the parsed PalWorldSettings.ini for the settings
// editor. This reads the file on the config mount — the source of truth for
// what the server boots with — not the live REST /settings, which reflects the
// currently-running config and can't be written back.
//
// 400 with a distinct message when the server has no config path, so the
// frontend can show setup guidance instead of an error.
func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	path, viaAgent, ok := s.resolveConfigPath(w, r, srv)
	if !ok {
		return
	}
	res, err := palconfig.Read(path)
	if errors.Is(err, palconfig.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no config path configured")
		return
	}
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "PalWorldSettings.ini not found at the configured path")
		return
	}
	if err != nil {
		s.logger.Error("reading server config failed", "server", srv.ID, "error", err)
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	// The cache path is an implementation detail; what the user should
	// see is where the file actually lives.
	if viaAgent {
		res.Path = "PalWorldSettings.ini · synced via palagent"
	}
	writeJSON(w, http.StatusOK, res)
}

// handleUpdateConfig writes changed settings back to PalWorldSettings.ini.
// Only existing keys can be changed and each value is validated against its
// type, so a bad edit is rejected whole rather than half-writing the file.
// Changes take effect when the server next restarts.
func (s *Server) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	var req struct {
		Changes map[string]string `json:"changes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	path, viaAgent, ok := s.resolveConfigPath(w, r, srv)
	if !ok {
		return
	}
	err := palconfig.Write(path, req.Changes)
	if errors.Is(err, palconfig.ErrNotConfigured) {
		writeError(w, http.StatusBadRequest, "no config path configured")
		return
	}
	if errors.Is(err, os.ErrPermission) {
		writeError(w, http.StatusBadGateway, "config file is read-only — mount it read-write to edit settings")
		return
	}
	if err != nil {
		// Validation failures (unknown key, wrong type) read as bad requests;
		// they're the caller's input, not a server fault.
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Agent-backed edits land on a local cache copy; ship it back to the
	// game server before reporting success, so a failed push fails loudly
	// instead of silently editing a file nothing reads.
	if viaAgent {
		if err := s.files.PushConfig(r.Context(), srv, path); err != nil {
			s.logger.Error("pushing config to agent failed", "server", srv.ID, "error", err)
			writeError(w, http.StatusBadGateway, "saving to the agent failed: "+err.Error())
			return
		}
	}

	// Record which keys changed — never the values, which include the
	// admin/join passwords.
	keys := make([]string, 0, len(req.Changes))
	for k := range req.Changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	s.audit(r, srv.ID, "config-update", strings.Join(keys, ", "))

	// Return the freshly-read settings so the client re-syncs to disk.
	res, err := palconfig.Read(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if viaAgent {
		res.Path = "PalWorldSettings.ini · synced via palagent"
	}
	writeJSON(w, http.StatusOK, res)
}

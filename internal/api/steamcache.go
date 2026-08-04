package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/safwyls/palcon/internal/steamcmd"
)

// handleClearSteamCache empties the SteamCMD cache directories — the
// equivalent of `rm -rf ./steamapps/* ./steam/packages/*` in the install
// root — so a container whose updater was corrupted by a game update can
// re-download cleanly. Prefers the server's agent when one is configured
// (the agent sits next to the game server and holds the volume); falls
// back to the locally bind-mounted install path. Gated on the power
// permission by the router: this exists to get a broken container updating
// again, and is useless without restart rights.
func (s *Server) handleClearSteamCache(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	user, _ := userFromContext(r.Context())
	actor := "unknown"
	if user != nil {
		actor = user.Username
	}

	var (
		removed int
		err     error
		via     string
	)
	switch {
	case srv.AgentURL != "":
		via = "agent"
		removed, err = s.agentFor(srv).ClearSteamCache(r.Context())
	case srv.InstallPath != "":
		via = "local"
		removed, err = steamcmd.ClearCache(srv.InstallPath)
	default:
		writeError(w, http.StatusBadRequest, "no agent or install path configured for this server")
		return
	}

	if err != nil {
		s.logger.Error("steam cache clear failed", "via", via, "server", srv.Name, "user", actor, "error", err)
		// A missing cache layout is a configuration problem, not a server
		// fault — tell the user rather than reporting a no-op success that
		// leaves their real cache corrupted.
		if errors.Is(err, steamcmd.ErrNotInstallRoot) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	s.logger.Info("steam cache cleared", "via", via, "removed", removed, "server", srv.Name, "user", actor)
	s.audit(r, srv.ID, "steam-cache-clear", fmt.Sprintf("%d entries via %s", removed, via))
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}

package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/store"
)

// agentFor builds the agentctl client for a server row. Errors collapse to
// nil deliberately: a malformed URL surfaces when a handler reports "no
// agent", and the row can't gain one without passing through the form
// again anyway.
func (s *Server) agentFor(srv *store.Server) *agentctl.Client {
	client, err := agentctl.New(srv.AgentURL, srv.AgentToken)
	if err != nil {
		return nil
	}
	return client
}

// writeAgentError maps agentctl's sentinel errors onto responses: the
// agent refusing (bad token, mis-set dir) is the user's configuration
// problem, busy is a conflict, a missing thing is a 404, and anything else
// is a gateway failure.
func writeAgentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, agentctl.ErrBusy):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, agentctl.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, agentctl.ErrRejected):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// handleSteamUpdateStart asks the server's agent to run a SteamCMD
// app_update job. Gated on the power permission by the router. The one
// safety the agent can't provide in companion mode lives here: the agent
// shares a volume with the game server but not a PID namespace, so only
// palcon (via docker) knows whether the game is running — and updating
// under a live server corrupts the very state this exists to repair.
func (s *Server) handleSteamUpdateStart(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	agent := s.agentFor(srv)
	if agent == nil {
		writeError(w, http.StatusBadRequest, "no agent configured for this server")
		return
	}

	// Whether the *game* is running is the question; the container is only
	// a proxy for it, and a bad one under a supervisor. A supervised
	// container runs palagent as PID 1, so it is always up even with the
	// game stopped — reading container state there would refuse every
	// update forever, and stopping the container to satisfy it would kill
	// the agent that has to perform the update. The agent answers
	// first-hand instead (palagent's own guard on game.Running), so palcon
	// asks it and skips the container entirely.
	if _, health := s.agentSupervisor(r.Context(), srv); health != nil {
		if health.Game.State == "running" {
			writeError(w, http.StatusConflict, "stop the server before updating — SteamCMD can't safely touch a live install")
			return
		}
	} else if s.docker != nil && srv.ContainerName != "" {
		// Companion mode: the agent shares a volume with the game but not a
		// PID namespace, so only palcon (via docker) knows if it's running.
		state, err := s.docker.Inspect(r.Context(), srv.ContainerName)
		if err == nil && state.Running {
			writeError(w, http.StatusConflict, "stop the server before updating — SteamCMD can't safely touch a live install")
			return
		}
		// An inspect failure doesn't block the update: the docker proxy
		// being down shouldn't also break repairing the game install.
	}

	var req struct {
		Validate bool `json:"validate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user, _ := userFromContext(r.Context())
	actor := "unknown"
	if user != nil {
		actor = user.Username
	}

	job, err := agent.StartUpdate(r.Context(), req.Validate)
	if err != nil {
		s.logger.Error("steam update failed to start", "server", srv.Name, "user", actor, "error", err)
		writeAgentError(w, err)
		return
	}
	s.logger.Info("steam update started", "server", srv.Name, "job", job.ID, "validate", req.Validate, "user", actor)
	s.audit(r, srv.ID, "steam-update", job.ID)
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job})
}

// handleSteamUpdateStatus reports the agent's current (or last) job, from
// its /v1/health. Going through health rather than a stored job id keeps
// palcon stateless about jobs — a palcon restart mid-update rediscovers
// the work instead of forgetting it.
func (s *Server) handleSteamUpdateStatus(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	agent := s.agentFor(srv)
	if agent == nil {
		writeError(w, http.StatusBadRequest, "no agent configured for this server")
		return
	}
	health, err := agent.Health(r.Context())
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": health.Job, "agent": map[string]any{
		"version":       health.Version,
		"apiVersion":    health.APIVersion,
		"mode":          health.Mode,
		"installDirOk":  health.InstallDirOk,
		"diskFreeBytes": health.DiskFreeBytes,
	}})
}

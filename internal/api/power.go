package api

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/safwyls/palcon/internal/dockerctl"
	"github.com/safwyls/palcon/internal/store"
)

// containerForRequest resolves the server and its configured container,
// reporting the two "not set up" cases distinctly so the UI can explain
// which half is missing.
func (s *Server) containerForRequest(w http.ResponseWriter, r *http.Request) (string, bool) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return "", false
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "server not found")
		return "", false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load server")
		return "", false
	}
	if s.docker == nil {
		writeError(w, http.StatusBadRequest, "docker control is not configured on this Palcon instance")
		return "", false
	}
	if srv.ContainerName == "" {
		writeError(w, http.StatusBadRequest, "no container name configured for this server")
		return "", false
	}
	return srv.ContainerName, true
}

func (s *Server) handleContainerStatus(w http.ResponseWriter, r *http.Request) {
	name, ok := s.containerForRequest(w, r)
	if !ok {
		return
	}
	state, err := s.docker.Inspect(r.Context(), name)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

// handleContainerAction performs start/stop/restart. Gated on the power
// permission by the router, and every call is logged with the user who
// made it — bouncing a server other people are playing on should never be
// anonymous.
func (s *Server) handleContainerAction(w http.ResponseWriter, r *http.Request) {
	name, ok := s.containerForRequest(w, r)
	if !ok {
		return
	}
	action := chi.URLParam(r, "action")
	user, _ := userFromContext(r.Context())
	actor := "unknown"
	if user != nil {
		actor = user.Username
	}

	var err error
	switch action {
	case "start":
		err = s.docker.Start(r.Context(), name)
	case "stop":
		err = s.docker.Stop(r.Context(), name)
	case "restart":
		err = s.docker.Restart(r.Context(), name)
	default:
		writeError(w, http.StatusBadRequest, "unknown action")
		return
	}

	if err != nil {
		s.logger.Error("container action failed", "action", action, "container", name, "user", actor, "error", err)
		if errors.Is(err, dockerctl.ErrNotConfigured) {
			writeError(w, http.StatusBadRequest, "docker control is not configured")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	s.logger.Info("container action", "action", action, "container", name, "user", actor)
	state, err := s.docker.Inspect(r.Context(), name)
	if err != nil {
		// The action worked; only the follow-up read didn't.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

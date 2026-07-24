package api

import (
	"context"
	"errors"
	"net/http"
	"time"

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

// prepareForStop saves the world and asks the game to exit on its own,
// before the container is stopped.
//
// Palworld server images commonly ignore SIGTERM, so `docker stop` alone
// ends in SIGKILL and the container records exit code 137. Docker — and
// TrueNAS's app UI, which reads the same field — then reports that as
// "crashed", which is both alarming and, since nothing was written on the
// way out, accurate.
//
// Asking the game to shut itself down first fixes the cause rather than
// the symptom: the process exits normally with code 0, and `docker stop`
// (called immediately after) simply observes that clean exit inside its
// grace window. Running docker stop over the top also keeps Docker in
// charge of the transition, so a `restart: unless-stopped` policy sees an
// intentional stop instead of a process that died and needs reviving.
//
// Every step is best-effort: a server that's already unresponsive can't
// save or shut itself down, and neither must block stopping the container,
// which is often exactly why someone reached for the button.
func (s *Server) prepareForStop(r *http.Request, container, actor string) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	if err := client.Save(ctx); err != nil {
		s.logger.Warn("could not save world before stopping; stopping anyway",
			"container", container, "user", actor, "error", err)
	} else {
		s.logger.Info("saved world before stopping", "container", container, "user", actor)
	}

	// A short countdown rather than zero: it gives anyone still connected
	// the in-game warning, and the process begins exiting well within the
	// stop grace period that follows.
	if err := client.Shutdown(ctx, 1, "Server stopping"); err != nil {
		s.logger.Warn("could not ask the game to shut down; falling back to stopping the container",
			"container", container, "user", actor, "error", err)
		return
	}
	s.logger.Info("asked the game to shut down", "container", container, "user", actor)
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
		s.prepareForStop(r, name, actor)
		err = s.docker.Stop(r.Context(), name)
	case "restart":
		s.prepareForStop(r, name, actor)
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

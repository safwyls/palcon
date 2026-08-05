package api

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/dockerctl"
	"github.com/safwyls/palcon/internal/store"
)

// containerFor resolves the server's configured docker container,
// reporting the two "not set up" cases distinctly so the UI can explain
// which half is missing.
func (s *Server) containerFor(w http.ResponseWriter, srv *store.Server) (string, bool) {
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

// agentSupervisor returns the agent client and its health iff the
// server's agent reports supervisor mode — the signal that power control
// belongs to the agent rather than the docker proxy. Any failure (no
// agent, unreachable, companion mode) collapses to nil so callers fall
// back to docker.
func (s *Server) agentSupervisor(ctx context.Context, srv *store.Server) (*agentctl.Client, *agentctl.Health) {
	return agentctl.Supervisor(ctx, srv.AgentURL, srv.AgentToken)
}

// gameToContainerState maps the supervised game's status onto the shape
// the dashboard already renders, so supervisor-mode servers light up the
// existing power card unchanged.
func gameToContainerState(health *agentctl.Health) *dockerctl.State {
	game := health.Game
	st := &dockerctl.State{
		Name:    "palagent · supervisor",
		Status:  game.State,
		Running: game.State == "running",
	}
	if !game.StartedAt.IsZero() {
		st.StartedAt = game.StartedAt.Format(time.RFC3339)
	}
	if game.LastExitCode != nil {
		st.ExitCode = *game.LastExitCode
		st.FinishedAt = game.LastExitAt.Format(time.RFC3339)
	}
	return st
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
// which is often exactly why someone reached for the button. The return
// reports whether the game accepted the shutdown — i.e. whether an exit is
// now in flight that the caller should let finish.
func (s *Server) prepareForStop(ctx context.Context, r *http.Request, container, actor string) bool {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
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
		return false
	}
	s.logger.Info("asked the game to shut down", "container", container, "user", actor)
	return true
}

// gameSelfExitWindow is how long a supervised game that accepted an
// in-game shutdown gets to finish exiting before the agent signals it.
// Generous on purpose: the countdown, the final save and the engine's
// teardown all happen inside it, and overrunning it only costs the SIGTERM
// that used to be sent immediately.
const gameSelfExitWindow = agentctl.GameSelfExitWindow

// ansiEscape strips terminal color codes some server images write into
// their logs; the viewer renders plain text.
var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

// handleContainerLogs returns the tail of the container's log. Gated on the
// power permission by the router: logs can carry chat and player identities,
// which is container-management territory, not general viewing.
func (s *Server) handleContainerLogs(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	tail := 300
	if n, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil && n > 0 {
		tail = min(n, 2000)
	}
	if agent, _ := s.agentSupervisor(r.Context(), srv); agent != nil {
		lines, err := agent.GameLogs(r.Context(), tail)
		if err != nil {
			writeAgentError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"lines": lines})
		return
	}
	name, ok := s.containerFor(w, srv)
	if !ok {
		return
	}
	raw, err := s.docker.Logs(r.Context(), name, tail)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	lines := strings.Split(strings.TrimRight(ansiEscape.ReplaceAllString(raw, ""), "\n"), "\n")
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines})
}

func (s *Server) handleContainerStatus(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	if _, health := s.agentSupervisor(r.Context(), srv); health != nil {
		writeJSON(w, http.StatusOK, gameToContainerState(health))
		return
	}
	name, ok := s.containerFor(w, srv)
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
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	action := chi.URLParam(r, "action")
	if action != "start" && action != "stop" && action != "restart" {
		writeError(w, http.StatusBadRequest, "unknown action")
		return
	}
	user, _ := userFromContext(r.Context())
	actor := "unknown"
	if user != nil {
		actor = user.Username
	}

	// Detached from the request: closing the tab right after clicking Stop
	// must not cancel the save → in-game shutdown → stop sequence midway,
	// leaving the world unsaved or the server half-stopped. Each step
	// still bounds itself with its own timeout.
	ctx := context.WithoutCancel(r.Context())

	// Supervisor-mode agents own the game process; the save-then-shutdown
	// courtesy before stopping is identical either way.
	if agent, _ := s.agentSupervisor(ctx, srv); agent != nil {
		// Unlike `docker stop` — which signals PID 1, an entrypoint script
		// that typically swallows SIGTERM — the agent signals the game's
		// whole process group, so a SIGTERM sent on top of an accepted
		// in-game shutdown lands on the engine mid-save and ends it at 143
		// instead of 0. Let that exit finish first.
		graceful := time.Duration(0)
		if action != "start" && s.prepareForStop(ctx, r, "palagent:"+srv.Name, actor) {
			graceful = gameSelfExitWindow
		}
		game, err := agent.Power(ctx, action, graceful)
		if err != nil {
			s.logger.Error("agent power action failed", "action", action, "server", srv.Name, "user", actor, "error", err)
			writeAgentError(w, err)
			return
		}
		s.logger.Info("agent power action", "action", action, "server", srv.Name, "user", actor)
		s.audit(r, srv.ID, "power-"+action, "palagent")
		writeJSON(w, http.StatusOK, gameToContainerState(&agentctl.Health{Game: game}))
		return
	}

	name, ok := s.containerFor(w, srv)
	if !ok {
		return
	}

	var err error
	switch action {
	case "start":
		err = s.docker.Start(ctx, name)
	case "stop":
		s.prepareForStop(ctx, r, name, actor)
		err = s.docker.Stop(ctx, name)
	case "restart":
		s.prepareForStop(ctx, r, name, actor)
		err = s.docker.Restart(ctx, name)
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
	s.audit(r, serverIDOf(r), "power-"+action, name)
	state, err := s.docker.Inspect(r.Context(), name)
	if err != nil {
		// The action worked; only the follow-up read didn't.
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, state)
}

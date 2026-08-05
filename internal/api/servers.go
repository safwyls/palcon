package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/store"
)

// serverDTO is what the API exposes for a server: never includes
// passwords, only whether they're set, so the frontend can prompt the
// user to enter a new one without ever displaying the old one.
type serverDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	// Game is the registered game id this server runs, and Features the
	// views that game can fill, in nav order. Together they are what lets
	// the frontend build a nav for a game it wasn't compiled against
	// knowing about, instead of hardcoding one game's view list.
	Game            string   `json:"game"`
	Features        []string `json:"features"`
	Host            string   `json:"host"`
	RCONPort        int      `json:"rconPort"`
	HasRCONPassword bool     `json:"hasRconPassword"`
	RESTPort        int      `json:"restPort"`
	HasRESTPassword bool     `json:"hasRestPassword"`
	GamePort        int      `json:"gamePort"`
	JoinAddress     string   `json:"joinAddress"`
	UseREST         bool     `json:"useRest"`
	Enabled         bool     `json:"enabled"`
	SavePath        string   `json:"savePath"`
	ConfigPath      string   `json:"configPath"`
	InstallPath     string   `json:"installPath"`
	AgentURL        string   `json:"agentUrl"`
	HasAgentToken   bool     `json:"hasAgentToken"`
	ContainerName   string   `json:"containerName"`
	// Views an admin has switched off for this server. Sent to every signed-in
	// user because the nav has to know what to leave out; it names the hidden
	// views, never their contents. Admins still get the data behind them.
	HiddenFeatures []string `json:"hiddenFeatures"`
}

func toDTO(srv *store.Server) serverDTO {
	return serverDTO{
		ID:              srv.ID,
		Name:            srv.Name,
		Game:            srv.Game,
		Features:        srv.Features(),
		Host:            srv.Host,
		RCONPort:        srv.RCONPort,
		HasRCONPassword: srv.RCONPassword != "",
		RESTPort:        srv.RESTPort,
		HasRESTPassword: srv.RESTPassword != "",
		GamePort:        srv.GamePort,
		JoinAddress:     srv.JoinAddress,
		UseREST:         srv.UseREST,
		Enabled:         srv.Enabled,
		SavePath:        srv.SavePath,
		ConfigPath:      srv.ConfigPath,
		InstallPath:     srv.InstallPath,
		AgentURL:        srv.AgentURL,
		HasAgentToken:   srv.AgentToken != "",
		ContainerName:   srv.ContainerName,
		HiddenFeatures:  srv.HiddenFeatures,
	}
}

type serverWriteRequest struct {
	Name          string `json:"name"`
	Host          string `json:"host"`
	RCONPort      int    `json:"rconPort"`
	RCONPassword  string `json:"rconPassword"`
	RESTPort      int    `json:"restPort"`
	RESTPassword  string `json:"restPassword"`
	GamePort      int    `json:"gamePort"`
	JoinAddress   string `json:"joinAddress"`
	UseREST       bool   `json:"useRest"`
	Enabled       bool   `json:"enabled"`
	SavePath      string `json:"savePath"`
	ConfigPath    string `json:"configPath"`
	InstallPath   string `json:"installPath"`
	AgentURL      string `json:"agentUrl"`
	AgentToken    string `json:"agentToken"`
	ContainerName string `json:"containerName"`
}

func serverIDFromRequest(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "serverID"), 10, 64)
}

// loadServer resolves the {serverID} route param to its stored row, writing
// the appropriate error response and returning ok=false on any failure. The
// single error-mapping point for handlers that need the row itself; the
// action handlers' equivalent is clientForServerID + writeServerLoadError.
func (s *Server) loadServer(w http.ResponseWriter, r *http.Request) (*store.Server, bool) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return nil, false
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "server not found")
		return nil, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load server")
		return nil, false
	}
	return srv, true
}

func (s *Server) handleListServers(w http.ResponseWriter, r *http.Request) {
	servers, err := s.store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list servers")
		return
	}
	dtos := make([]serverDTO, len(servers))
	for i, srv := range servers {
		dtos[i] = toDTO(srv)
	}
	writeJSON(w, http.StatusOK, dtos)
}

func (s *Server) handleGetServer(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, toDTO(srv))
}

func (s *Server) handleCreateServer(w http.ResponseWriter, r *http.Request) {
	var req serverWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	srv := &store.Server{
		Name: req.Name, Host: req.Host,
		RCONPort: req.RCONPort, RCONPassword: req.RCONPassword,
		RESTPort: req.RESTPort, RESTPassword: req.RESTPassword, GamePort: req.GamePort,
		JoinAddress: req.JoinAddress, UseREST: req.UseREST, Enabled: req.Enabled,
		SavePath: req.SavePath, ConfigPath: req.ConfigPath, InstallPath: req.InstallPath,
		AgentURL: req.AgentURL, AgentToken: req.AgentToken, ContainerName: req.ContainerName,
	}
	id, err := s.store.CreateServer(r.Context(), srv)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create server")
		return
	}
	srv.ID = id
	s.audit(r, id, "server-create", srv.Name)
	writeJSON(w, http.StatusCreated, toDTO(srv))
}

func (s *Server) handleUpdateServer(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	var req serverWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	srv := &store.Server{
		ID: id, Name: req.Name, Host: req.Host,
		RCONPort: req.RCONPort, RCONPassword: req.RCONPassword,
		RESTPort: req.RESTPort, RESTPassword: req.RESTPassword, GamePort: req.GamePort,
		JoinAddress: req.JoinAddress, UseREST: req.UseREST, Enabled: req.Enabled,
		SavePath: req.SavePath, ConfigPath: req.ConfigPath, InstallPath: req.InstallPath,
		AgentURL: req.AgentURL, AgentToken: req.AgentToken, ContainerName: req.ContainerName,
	}
	if err := s.store.UpdateServer(r.Context(), srv); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update server")
		return
	}
	// Blank passwords in the request mean "keep the stored one", so the
	// DTO must come from the stored row or hasRconPassword/hasRestPassword
	// would misreport as false after any edit that doesn't resend them.
	stored, err := s.store.GetServer(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload server")
		return
	}
	s.audit(r, id, "server-update", stored.Name)
	writeJSON(w, http.StatusOK, toDTO(stored))
}

// serverSharingContainer names another server row pointing at the same
// container, if one exists. Nothing stops two rows naming one
// container — adopt doesn't check, and the edit form takes any name — so
// destroying on behalf of one would silently unmake the other's server.
func (s *Server) serverSharingContainer(ctx context.Context, srv *store.Server) (string, error) {
	servers, err := s.store.ListServers(ctx)
	if err != nil {
		return "", err
	}
	for _, other := range servers {
		if other.ID != srv.ID && other.ContainerName == srv.ContainerName {
			return other.Name, nil
		}
	}
	return "", nil
}

// handleDeleteServer drops the server row and, with ?removeContainer=true,
// asks the provisioner to destroy the container first.
//
// The ordering is handleProvisionServer's in reverse, for the same reason:
// destroy first, delete the row after. A destroy that fails keeps the row,
// so the operator still has the card and the credentials to retry from.
// Deleting the row first would leave a live container that palcon can only
// reach again through adoption — and the container name it needed to
// destroy it lives on that row.
func (s *Server) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	wantDestroy := r.URL.Query().Get("removeContainer") == "true"

	// A plain delete stays idempotent, the way it was before the destroy
	// option existed: the store's DELETE succeeds on zero rows, so a retry
	// or the loser of two concurrent deletes still gets 204 rather than a
	// 404 that reads as failure to a script. Only the destroy path needs
	// the row, for the container name on it.
	srv := &store.Server{ID: id}
	if wantDestroy {
		loaded, ok := s.loadServer(w, r)
		if !ok {
			return
		}
		srv = loaded
	}

	// Detached from the request, like the power handler's stop sequence:
	// the provisioner stops the container (up to 30s of grace) before
	// removing it, and a closed tab must not cancel that halfway and leave
	// it stopped-but-present — nor cancel between the destroy and the row
	// delete, splitting the two halves of one operation.
	ctx := context.WithoutCancel(r.Context())

	destroyed, dataDir := "", ""
	if wantDestroy {
		switch {
		case s.Provisioner == nil:
			writeError(w, http.StatusBadRequest,
				"no provisioner is configured — remove the container wherever it was deployed")
			return
		case srv.ContainerName == "":
			writeError(w, http.StatusBadRequest, "no container name is recorded for this server")
			return
		}
		other, err := s.serverSharingContainer(ctx, srv)
		if err != nil {
			// Failing open here would destroy a container this check exists
			// to protect; not knowing is a reason to stop, not proceed.
			writeError(w, http.StatusInternalServerError, "could not check whether another server uses this container")
			return
		}
		if other != "" {
			// Destroying it would pull the container out from under a server
			// that is still registered and still expects it to be there.
			writeError(w, http.StatusConflict,
				fmt.Sprintf("%q also uses container %s — remove that server first, or delete this one without destroying",
					other, srv.ContainerName))
			return
		}
		res, err := s.Provisioner.Destroy(ctx, srv.ContainerName)
		switch {
		case err == nil:
			destroyed, dataDir = res.Container, res.DataDir
			s.audit(r, srv.ID, "server-destroy", destroyed)
			s.logger.Info("destroyed container", "server", srv.Name, "container", destroyed, "dataKept", dataDir)
		case errors.Is(err, agentctl.ErrNotFound):
			// Already gone — someone removed it by hand, or a previous
			// attempt destroyed it and then failed to drop the row. The end
			// state is the one that was asked for, so carry on and delete
			// the row rather than trapping the operator in a retry that can
			// never succeed.
			s.logger.Info("container already gone; deleting the row",
				"server", srv.Name, "container", srv.ContainerName)
			s.audit(r, srv.ID, "server-destroy", srv.ContainerName+" (already gone)")
		default:
			s.logger.Error("destroy container failed",
				"server", srv.Name, "container", srv.ContainerName, "error", err)
			writeAgentError(w, err)
			return
		}
	}
	if err := s.store.DeleteServer(ctx, srv.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete server")
		return
	}
	// The audit row outlives the server row (no FK) — the trail of a
	// deletion shouldn't be deleted by it.
	s.audit(r, srv.ID, "server-delete", "")
	if destroyed == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"destroyed": destroyed, "dataDir": dataDir})
}

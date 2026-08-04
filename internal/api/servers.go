package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

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

func (s *Server) handleDeleteServer(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	if err := s.store.DeleteServer(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete server")
		return
	}
	// The audit row outlives the server row (no FK) — the trail of a
	// deletion shouldn't be deleted by it.
	s.audit(r, id, "server-delete", "")
	w.WriteHeader(http.StatusNoContent)
}

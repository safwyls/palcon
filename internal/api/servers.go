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
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Host            string `json:"host"`
	RCONPort        int    `json:"rconPort"`
	HasRCONPassword bool   `json:"hasRconPassword"`
	RESTPort        int    `json:"restPort"`
	HasRESTPassword bool   `json:"hasRestPassword"`
	UseREST         bool   `json:"useRest"`
	Enabled         bool   `json:"enabled"`
	SavePath        string `json:"savePath"`
	ContainerName   string `json:"containerName"`
}

func toDTO(srv *store.Server) serverDTO {
	return serverDTO{
		ID:              srv.ID,
		Name:            srv.Name,
		Host:            srv.Host,
		RCONPort:        srv.RCONPort,
		HasRCONPassword: srv.RCONPassword != "",
		RESTPort:        srv.RESTPort,
		HasRESTPassword: srv.RESTPassword != "",
		UseREST:         srv.UseREST,
		Enabled:         srv.Enabled,
		SavePath:        srv.SavePath,
		ContainerName:   srv.ContainerName,
	}
}

type serverWriteRequest struct {
	Name          string `json:"name"`
	Host          string `json:"host"`
	RCONPort      int    `json:"rconPort"`
	RCONPassword  string `json:"rconPassword"`
	RESTPort      int    `json:"restPort"`
	RESTPassword  string `json:"restPassword"`
	UseREST       bool   `json:"useRest"`
	Enabled       bool   `json:"enabled"`
	SavePath      string `json:"savePath"`
	ContainerName string `json:"containerName"`
}

func serverIDFromRequest(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "serverID"), 10, 64)
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
		RESTPort: req.RESTPort, RESTPassword: req.RESTPassword,
		UseREST: req.UseREST, Enabled: req.Enabled,
		SavePath: req.SavePath, ContainerName: req.ContainerName,
	}
	id, err := s.store.CreateServer(r.Context(), srv)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create server")
		return
	}
	srv.ID = id
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
		RESTPort: req.RESTPort, RESTPassword: req.RESTPassword,
		UseREST: req.UseREST, Enabled: req.Enabled,
		SavePath: req.SavePath, ContainerName: req.ContainerName,
	}
	if err := s.store.UpdateServer(r.Context(), srv); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update server")
		return
	}
	writeJSON(w, http.StatusOK, toDTO(srv))
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
	w.WriteHeader(http.StatusNoContent)
}

package api

import (
	"encoding/json"
	"net/http"

	"github.com/safwyls/palcon/internal/palworld"
	"github.com/safwyls/palcon/internal/store"
)

func (s *Server) clientForServerID(r *http.Request) (palworld.Client, *store.Server, error) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		return nil, nil, err
	}
	srv, err := s.store.GetServer(r.Context(), id)
	if err != nil {
		return nil, nil, err
	}
	client := palworld.New(palworld.Config{
		Host:         srv.Host,
		RESTPort:     srv.RESTPort,
		RESTPassword: srv.RESTPassword,
		RCONPort:     srv.RCONPort,
		RCONPassword: srv.RCONPassword,
		PreferREST:   srv.UseREST,
	})
	return client, srv, nil
}

func (s *Server) withClient(w http.ResponseWriter, r *http.Request, fn func(palworld.Client) error) {
	client, _, err := s.clientForServerID(r)
	if err == store.ErrNotFound {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}
	if err := fn(client); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleServerInfo(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	info, err := client.Info(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleServerPlayers(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	players, err := client.Players(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, players)
}

func (s *Server) handleServerBroadcast(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Broadcast(r.Context(), req.Message)
	})
}

func (s *Server) handleServerKick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Kick(r.Context(), req.PlayerUID, req.Message)
	})
}

func (s *Server) handleServerBan(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
		Message   string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Ban(r.Context(), req.PlayerUID, req.Message)
	})
}

func (s *Server) handleServerUnban(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PlayerUID string `json:"playerUid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Unban(r.Context(), req.PlayerUID)
	})
}

func (s *Server) handleServerSave(w http.ResponseWriter, r *http.Request) {
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Save(r.Context())
	})
}

func (s *Server) handleServerShutdown(w http.ResponseWriter, r *http.Request) {
	var req struct {
		WaitSeconds int    `json:"waitSeconds"`
		Message     string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	s.withClient(w, r, func(c palworld.Client) error {
		return c.Shutdown(r.Context(), req.WaitSeconds, req.Message)
	})
}

func (s *Server) handleServerSettings(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	ext, ok := client.(palworld.ExtendedClient)
	if !ok {
		writeError(w, http.StatusBadRequest, "this server is configured RCON-only; settings require the REST API")
		return
	}
	settings, err := ext.Settings(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) handleServerMetrics(w http.ResponseWriter, r *http.Request) {
	client, _, err := s.clientForServerID(r)
	if err != nil {
		writeError(w, http.StatusNotFound, "server not found")
		return
	}
	ext, ok := client.(palworld.ExtendedClient)
	if !ok {
		writeError(w, http.StatusBadRequest, "this server is configured RCON-only; metrics require the REST API")
		return
	}
	metrics, err := ext.Metrics(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, metrics)
}

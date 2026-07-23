// Package api wires up the HTTP server: auth, server CRUD, and the
// per-server RCON/REST actions, plus serving the built React SPA.
package api

import (
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/safwyls/palcon/internal/palsave"
	"github.com/safwyls/palcon/internal/store"
)

type Server struct {
	store     *store.Store
	jwtSecret []byte
	logger    *slog.Logger
	palReader *palsave.Reader
}

func New(st *store.Store, jwtSecret []byte, logger *slog.Logger, palReader *palsave.Reader) *Server {
	return &Server{store: st, jwtSecret: jwtSecret, logger: logger, palReader: palReader}
}

// Routes builds the full HTTP handler: JSON API under /api, and the built
// frontend (staticFS) for everything else, with an index.html fallback so
// client-side routing works on refresh/deep links.
func (s *Server) Routes(staticFS fs.FS) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api", func(r chi.Router) {
		r.NotFound(func(w http.ResponseWriter, r *http.Request) {
			writeError(w, http.StatusNotFound, "not found")
		})
		r.Post("/login", s.handleLogin)

		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Post("/logout", s.handleLogout)
			r.Get("/me", s.handleMe)

			r.Get("/servers", s.handleListServers)
			r.Post("/servers", s.handleCreateServer)
			r.Route("/servers/{serverID}", func(r chi.Router) {
				r.Get("/", s.handleGetServer)
				r.Put("/", s.handleUpdateServer)
				r.Delete("/", s.handleDeleteServer)

				r.Get("/info", s.handleServerInfo)
				r.Get("/players", s.handleServerPlayers)
				r.Post("/broadcast", s.handleServerBroadcast)
				r.Post("/kick", s.handleServerKick)
				r.Post("/ban", s.handleServerBan)
				r.Post("/unban", s.handleServerUnban)
				r.Post("/save", s.handleServerSave)
				r.Post("/shutdown", s.handleServerShutdown)
				r.Get("/settings", s.handleServerSettings)
				r.Get("/metrics", s.handleServerMetrics)
				r.Get("/pals", s.handleServerPals)
			})
		})
	})

	r.NotFound(spaHandler(staticFS))

	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

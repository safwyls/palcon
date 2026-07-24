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

	"github.com/safwyls/palcon/internal/dockerctl"
	"github.com/safwyls/palcon/internal/palsave"
	"github.com/safwyls/palcon/internal/store"
)

type Server struct {
	store     *store.Store
	jwtSecret []byte
	logger    *slog.Logger
	palReader *palsave.Reader
	// docker is nil when no DOCKER_HOST is set; power control is then
	// simply unavailable rather than broken.
	docker *dockerctl.Client
}

func New(st *store.Store, jwtSecret []byte, logger *slog.Logger, palReader *palsave.Reader, docker *dockerctl.Client) *Server {
	return &Server{store: st, jwtSecret: jwtSecret, logger: logger, palReader: palReader, docker: docker}
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
			r.Post("/me/password", s.handleChangeOwnPassword)

			// Registered flat rather than via r.Route: a subrouter's "/"
			// only matches /users/, so POST /api/users 404s.
			r.With(s.requireAdmin).Get("/users", s.handleListUsers)
			r.With(s.requireAdmin).Post("/users", s.handleCreateUser)
			r.With(s.requireAdmin).Put("/users/{userID}", s.handleUpdateUser)
			r.With(s.requireAdmin).Delete("/users/{userID}", s.handleDeleteUser)

			r.Get("/servers", s.handleListServers)
			r.With(s.requireAdmin).Post("/servers", s.handleCreateServer)
			r.Route("/servers/{serverID}", func(r chi.Router) {
				r.Get("/", s.handleGetServer)
				r.With(s.requireAdmin).Put("/", s.handleUpdateServer)
				r.With(s.requireAdmin).Delete("/", s.handleDeleteServer)

				r.Get("/info", s.handleServerInfo)
				r.Get("/players", s.handleServerPlayers)
				r.With(s.requirePermission(store.PermBroadcast)).Post("/broadcast", s.handleServerBroadcast)
				r.With(s.requirePermission(store.PermModerate)).Post("/kick", s.handleServerKick)
				r.With(s.requirePermission(store.PermModerate)).Post("/ban", s.handleServerBan)
				r.With(s.requirePermission(store.PermModerate)).Post("/unban", s.handleServerUnban)
				r.With(s.requirePermission(store.PermSave)).Post("/save", s.handleServerSave)
				r.With(s.requirePermission(store.PermShutdown)).Post("/shutdown", s.handleServerShutdown)

				// Container power. Reading state is fine for anyone
				// signed in; changing it needs the grant.
				r.Get("/container", s.handleContainerStatus)
				r.With(s.requirePermission(store.PermPower)).Post("/container/{action}", s.handleContainerAction)
				r.Get("/settings", s.handleServerSettings)
				r.Get("/metrics", s.handleServerMetrics)
				r.Get("/metrics/history", s.handleServerMetricsHistory)
				r.Get("/pals", s.handleServerPals)
				r.Get("/guilds", s.handleServerGuilds)
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

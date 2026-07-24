package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/safwyls/palcon/internal/store"
)

var errBootstrapPasswordRequired = errors.New("ADMIN_PASSWORD must be set for the first run (no users exist yet)")

type contextKey string

const userContextKey contextKey = "user"

func userFromContext(ctx context.Context) (*store.User, bool) {
	v, ok := ctx.Value(userContextKey).(*store.User)
	return v, ok
}

// requireAuth verifies the session cookie and loads the user it belongs to.
//
// The user is re-read from the database on every request rather than
// trusted from the token: permissions are meant to be revocable, and
// claims baked into a week-long session would keep working until it
// expired. It also means disabling an account takes effect at once.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(sessionCookieName)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		claims, err := s.parseSession(cookie.Value)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}
		user, err := s.store.GetUser(r.Context(), claims.UserID)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "account no longer exists")
			return
		}
		if user.Disabled {
			writeError(w, http.StatusForbidden, "account disabled")
			return
		}
		ctx := context.WithValue(r.Context(), userContextKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requirePermission gates a route on a single grant. Admins pass everything.
func (s *Server) requirePermission(permission string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := userFromContext(r.Context())
			if !ok || !user.Can(permission) {
				writeError(w, http.StatusForbidden, "you do not have permission to do that")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, ok := userFromContext(r.Context())
		if !ok || !user.IsAdmin() {
			writeError(w, http.StatusForbidden, "admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

package api

import (
	"context"
	"errors"
	"net/http"
)

var errBootstrapPasswordRequired = errors.New("ADMIN_PASSWORD must be set for the first run (no users exist yet)")

type contextKey string

const usernameContextKey contextKey = "username"

func usernameFromContext(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(usernameContextKey).(string)
	return v, ok
}

// requireAuth verifies the session cookie and injects the username into
// the request context; it rejects the request with 401 otherwise.
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
		ctx := context.WithValue(r.Context(), usernameContextKey, claims.Username)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

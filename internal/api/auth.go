package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/safwyls/palcon/internal/store"
)

const sessionCookieName = "palcon_session"
const sessionDuration = 7 * 24 * time.Hour

type sessionClaims struct {
	Username string `json:"username"`
	jwt.RegisteredClaims
}

func (s *Server) signSession(username string) (string, error) {
	claims := sessionClaims{
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(sessionDuration)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.jwtSecret)
}

func (s *Server) parseSession(tokenStr string) (*sessionClaims, error) {
	claims := &sessionClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		return s.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	user, err := s.store.GetUserByUsername(r.Context(), req.Username)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}

	token, err := s.signSession(user.Username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(sessionDuration),
	})
	writeJSON(w, http.StatusOK, map[string]string{"username": user.Username})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Unix(0, 0),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	username, _ := usernameFromContext(r.Context())
	writeJSON(w, http.StatusOK, map[string]string{"username": username})
}

// BootstrapAdmin creates the initial admin user from ADMIN_USERNAME/
// ADMIN_PASSWORD if the users table is still empty. Safe to call on every
// startup; it's a no-op once any user exists.
func BootstrapAdmin(ctx context.Context, s *store.Store, username, password string) error {
	count, err := s.CountUsers(ctx)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	if password == "" {
		return errBootstrapPasswordRequired
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.CreateUser(ctx, username, string(hash), "admin")
	return err
}

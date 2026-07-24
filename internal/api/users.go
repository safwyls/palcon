package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/safwyls/palcon/internal/store"
)

type userDTO struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Disabled    bool     `json:"disabled"`
}

func toUserDTO(u *store.User) userDTO {
	perms := u.Permissions
	if perms == nil {
		perms = []string{}
	}
	return userDTO{
		ID:          u.ID,
		Username:    u.Username,
		Role:        u.Role,
		Permissions: perms,
		Disabled:    u.Disabled,
	}
}

func userIDFromRequest(r *http.Request) (int64, error) {
	return strconv.ParseInt(chi.URLParam(r, "userID"), 10, 64)
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list users")
		return
	}
	out := make([]userDTO, len(users))
	for i, u := range users {
		out[i] = toUserDTO(u)
	}
	writeJSON(w, http.StatusOK, out)
}

type userWriteRequest struct {
	Username    string   `json:"username"`
	Password    string   `json:"password"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Disabled    bool     `json:"disabled"`
}

// Short enough to be memorable for a player, long enough not to be
// trivially guessable on a LAN service.
const minPasswordLength = 8

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var req userWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" {
		writeError(w, http.StatusBadRequest, "username is required")
		return
	}
	if len(req.Password) < minPasswordLength {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	if _, err := s.store.GetUserByUsername(r.Context(), req.Username); err == nil {
		writeError(w, http.StatusConflict, "that username is taken")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	role := req.Role
	if role != store.RoleAdmin {
		role = "user"
	}
	id, err := s.store.CreateUser(r.Context(), req.Username, string(hash), role, req.Permissions)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	user, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load new user")
		return
	}
	writeJSON(w, http.StatusCreated, toUserDTO(user))
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, err := userIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	var req userWriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	role := req.Role
	if role != store.RoleAdmin {
		role = "user"
	}

	// Losing the last admin would leave nobody able to grant it back, so
	// block the demotion rather than let someone lock themselves out.
	if target.IsAdmin() && (role != store.RoleAdmin || req.Disabled) {
		admins, err := s.store.CountAdmins(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check admins")
			return
		}
		if admins <= 1 {
			writeError(w, http.StatusBadRequest, "this is the only admin — promote someone else first")
			return
		}
	}

	if err := s.store.UpdateUser(r.Context(), id, role, req.Permissions, req.Disabled); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update user")
		return
	}
	if req.Password != "" {
		if len(req.Password) < minPasswordLength {
			writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		if err := s.store.SetUserPassword(r.Context(), id, string(hash)); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to set password")
			return
		}
	}

	updated, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload user")
		return
	}
	writeJSON(w, http.StatusOK, toUserDTO(updated))
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := userIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid user id")
		return
	}
	actor, _ := userFromContext(r.Context())
	if actor != nil && actor.ID == id {
		writeError(w, http.StatusBadRequest, "you cannot delete your own account")
		return
	}
	target, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if target.IsAdmin() {
		admins, err := s.store.CountAdmins(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to check admins")
			return
		}
		if admins <= 1 {
			writeError(w, http.StatusBadRequest, "this is the only admin — promote someone else first")
			return
		}
	}
	if err := s.store.DeleteUser(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete user")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleChangeOwnPassword lets any signed-in user rotate their own
// password, which they must be able to do without an admin's help.
func (s *Server) handleChangeOwnPassword(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "not authenticated")
		return
	}
	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)) != nil {
		writeError(w, http.StatusForbidden, "current password is incorrect")
		return
	}
	if len(req.NewPassword) < minPasswordLength {
		writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	if err := s.store.SetUserPassword(r.Context(), user.ID, string(hash)); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to set password")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

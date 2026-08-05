package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/safwyls/palcon/internal/notify"
	"github.com/safwyls/palcon/internal/sched"
	"github.com/safwyls/palcon/internal/store"
)

// scheduleJSON is the wire form of a restart schedule. Times are the
// palcon host's local wall clock; the automation payload carries the
// timezone name so the UI can label them honestly.
type scheduleJSON struct {
	ID             int64   `json:"id"`
	Enabled        bool    `json:"enabled"`
	Days           []int   `json:"days"`
	TimeOfDay      string  `json:"timeOfDay"`
	WarningMinutes []int   `json:"warningMinutes"`
	LastRunAt      *string `json:"lastRunAt"`
	NextRunAt      *string `json:"nextRunAt"`
}

// discordJSON never carries the webhook URL back out — like server
// passwords, it's write-only through the API.
type discordJSON struct {
	Configured bool `json:"configured"`
	Enabled    bool `json:"enabled"`
	OnStatus   bool `json:"onStatus"`
	OnPlayers  bool `json:"onPlayers"`
	OnRestarts bool `json:"onRestarts"`
}

func scheduleToJSON(sc *store.RestartSchedule) scheduleJSON {
	out := scheduleJSON{
		ID:             sc.ID,
		Enabled:        sc.Enabled,
		Days:           sc.Days,
		TimeOfDay:      sc.TimeOfDay,
		WarningMinutes: sc.WarningMinutes,
	}
	if out.Days == nil {
		out.Days = []int{}
	}
	if out.WarningMinutes == nil {
		out.WarningMinutes = []int{}
	}
	if sc.LastRunAt != nil {
		s := sc.LastRunAt.UTC().Format(time.RFC3339)
		out.LastRunAt = &s
	}
	if sc.Enabled {
		if next := sched.NextRun(sc, time.Now()); !next.IsZero() {
			s := next.UTC().Format(time.RFC3339)
			out.NextRunAt = &s
		}
	}
	return out
}

// handleGetAutomation returns the whole automation state for the page in
// one read: schedules, Discord config (admins only — its existence and
// toggles are config detail), and context the UI needs to render times
// and explain restart behavior.
func (s *Server) handleGetAutomation(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	schedules, err := s.store.ListRestartSchedules(r.Context(), srv.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load schedules")
		return
	}
	scheduleList := make([]scheduleJSON, 0, len(schedules))
	for _, sc := range schedules {
		scheduleList = append(scheduleList, scheduleToJSON(sc))
	}

	tzName, _ := time.Now().Zone()
	resp := map[string]any{
		"schedules": scheduleList,
		"timezone":  tzName,
		// Whether a scheduled restart can bounce the container, or must
		// rely on an in-game shutdown + the container's restart policy.
		"dockerRestart": s.docker != nil && srv.ContainerName != "",
	}

	if user, _ := userFromContext(r.Context()); user != nil && user.IsAdmin() {
		var discord *discordJSON
		hook, err := s.store.GetDiscordWebhook(r.Context(), srv.ID)
		switch {
		case err == nil:
			discord = &discordJSON{
				Configured: true,
				Enabled:    hook.Enabled,
				OnStatus:   hook.OnStatus,
				OnPlayers:  hook.OnPlayers,
				OnRestarts: hook.OnRestarts,
			}
		case errors.Is(err, store.ErrNotFound):
			discord = &discordJSON{}
		default:
			writeError(w, http.StatusInternalServerError, "failed to load discord config")
			return
		}
		resp["discord"] = discord
		// A supervised server's container runs palagent as PID 1, so it
		// stays up whatever the game does — the watchdog would inspect it
		// forever and never see the crash it exists to catch. The agent's
		// own supervisor already restarts the game with backoff, so the
		// honest answer is that the feature has nothing to add here rather
		// than offering a switch that does nothing.
		_, supervised := s.agentSupervisor(r.Context(), srv)
		resp["watchdog"] = map[string]any{
			"enabled": srv.Watchdog,
			// Otherwise the same precondition as scheduled container
			// restarts: docker control plus a container name.
			"available":  supervised == nil && s.docker != nil && srv.ContainerName != "",
			"supervised": supervised != nil,
		}
		resp["publicStatus"] = map[string]any{
			"enabled": srv.PublicToken != "",
			"token":   srv.PublicToken,
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// handleUpdateWatchdog flips the crash watchdog. Its own endpoint (rather
// than a server-edit field) so the server form can never wipe it silently.
func (s *Server) handleUpdateWatchdog(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := s.store.SetWatchdog(r.Context(), srv.ID, in.Enabled); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update watchdog")
		return
	}
	detail := "off"
	if in.Enabled {
		detail = "on"
	}
	s.audit(r, srv.ID, "watchdog-update", detail)
	writeJSON(w, http.StatusOK, map[string]bool{"enabled": in.Enabled})
}

type scheduleWriteInput struct {
	Enabled        bool   `json:"enabled"`
	Days           []int  `json:"days"`
	TimeOfDay      string `json:"timeOfDay"`
	WarningMinutes []int  `json:"warningMinutes"`
}

// normalizeSchedule validates and canonicalizes a write: days deduped
// ascending, warnings deduped descending (the order they'll fire in).
func normalizeSchedule(in *scheduleWriteInput) (days, warnings []int, err error) {
	if _, e := time.Parse("15:04", in.TimeOfDay); e != nil {
		return nil, nil, errors.New("timeOfDay must be HH:MM (24-hour)")
	}
	seen := map[int]bool{}
	for _, d := range in.Days {
		if d < 0 || d > 6 {
			return nil, nil, errors.New("days must be 0 (Sunday) through 6 (Saturday)")
		}
		if !seen[d] {
			seen[d] = true
			days = append(days, d)
		}
	}
	if len(days) == 0 {
		return nil, nil, errors.New("at least one day is required")
	}
	sort.Ints(days)

	seenW := map[int]bool{}
	for _, m := range in.WarningMinutes {
		if m < 1 || m > 180 {
			return nil, nil, errors.New("warning minutes must be between 1 and 180")
		}
		if !seenW[m] {
			seenW[m] = true
			warnings = append(warnings, m)
		}
	}
	if len(warnings) > 8 {
		return nil, nil, errors.New("at most 8 warnings")
	}
	sort.Sort(sort.Reverse(sort.IntSlice(warnings)))
	return days, warnings, nil
}

func (s *Server) handleCreateSchedule(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	var in scheduleWriteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	days, warnings, err := normalizeSchedule(&in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sc := &store.RestartSchedule{
		ServerID:       srv.ID,
		Enabled:        in.Enabled,
		Days:           days,
		TimeOfDay:      in.TimeOfDay,
		WarningMinutes: warnings,
	}
	id, err := s.store.CreateRestartSchedule(r.Context(), sc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create schedule")
		return
	}
	sc.ID = id
	s.audit(r, srv.ID, "schedule-create", sc.TimeOfDay)
	writeJSON(w, http.StatusCreated, scheduleToJSON(sc))
}

func (s *Server) handleUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	scheduleID, err := strconv.ParseInt(chi.URLParam(r, "scheduleID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid schedule id")
		return
	}
	var in scheduleWriteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	days, warnings, err := normalizeSchedule(&in)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	sc := &store.RestartSchedule{
		ID:             scheduleID,
		ServerID:       srv.ID,
		Enabled:        in.Enabled,
		Days:           days,
		TimeOfDay:      in.TimeOfDay,
		WarningMinutes: warnings,
	}
	if err := s.store.UpdateRestartSchedule(r.Context(), sc); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "schedule not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update schedule")
		return
	}
	s.audit(r, srv.ID, "schedule-update", sc.TimeOfDay)
	// Re-read for LastRunAt, which the write path doesn't touch.
	stored, err := s.store.GetRestartSchedule(r.Context(), scheduleID)
	if err != nil {
		writeJSON(w, http.StatusOK, scheduleToJSON(sc))
		return
	}
	writeJSON(w, http.StatusOK, scheduleToJSON(stored))
}

func (s *Server) handleDeleteSchedule(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	scheduleID, err := strconv.ParseInt(chi.URLParam(r, "scheduleID"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid schedule id")
		return
	}
	if err := s.store.DeleteRestartSchedule(r.Context(), srv.ID, scheduleID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete schedule")
		return
	}
	s.audit(r, srv.ID, "schedule-delete", "")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUpdateDiscord(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	var in struct {
		WebhookURL string `json:"webhookUrl"`
		Enabled    bool   `json:"enabled"`
		OnStatus   bool   `json:"onStatus"`
		OnPlayers  bool   `json:"onPlayers"`
		OnRestarts bool   `json:"onRestarts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// Empty URL means "keep the stored one" (matching password updates);
	// a non-empty one must be a real Discord webhook endpoint.
	if in.WebhookURL != "" {
		if err := notify.ValidateWebhookURL(in.WebhookURL); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	err := s.store.SetDiscordWebhook(r.Context(), &store.DiscordWebhook{
		ServerID:   srv.ID,
		WebhookURL: in.WebhookURL,
		Enabled:    in.Enabled,
		OnStatus:   in.OnStatus,
		OnPlayers:  in.OnPlayers,
		OnRestarts: in.OnRestarts,
	})
	if err != nil {
		if in.WebhookURL == "" {
			writeError(w, http.StatusBadRequest, "a webhook URL is required")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to save discord config")
		return
	}
	// The webhook URL is a secret; the audit row only says whether one was
	// replaced or the toggles changed.
	what := "settings"
	if in.WebhookURL != "" {
		what = "webhook URL"
	}
	s.audit(r, srv.ID, "discord-update", what)
	writeJSON(w, http.StatusOK, discordJSON{
		Configured: true,
		Enabled:    in.Enabled,
		OnStatus:   in.OnStatus,
		OnPlayers:  in.OnPlayers,
		OnRestarts: in.OnRestarts,
	})
}

func (s *Server) handleDeleteDiscord(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteDiscordWebhook(r.Context(), srv.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete discord config")
		return
	}
	s.audit(r, srv.ID, "discord-delete", "")
	w.WriteHeader(http.StatusNoContent)
}

// handleTestDiscord fires a test message through the stored webhook and
// reports the failure detail, so "paste URL → Test" is a real check.
func (s *Server) handleTestDiscord(w http.ResponseWriter, r *http.Request) {
	srv, ok := s.loadServer(w, r)
	if !ok {
		return
	}
	if s.notifier == nil {
		writeError(w, http.StatusInternalServerError, "notifications are not running")
		return
	}
	if err := s.notifier.Test(r.Context(), srv); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

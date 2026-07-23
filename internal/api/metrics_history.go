package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/safwyls/palcon/internal/collector"
)

// metricPointDTO is one charted sample. Fields are pointers so a gap in the
// data reaches the frontend as null and breaks the line, rather than being
// drawn as a plunge to zero.
type metricPointDTO struct {
	TS          time.Time `json:"ts"`
	PlayerCount *int      `json:"playerCount"`
	MaxPlayers  *int      `json:"maxPlayers"`
	ServerFPS   *float64  `json:"serverFps"`
	FrameTime   *float64  `json:"frameTime"`
}

// handleServerMetricsHistory serves the dashboard performance charts.
// ?minutes selects the window, defaulting to an hour and capped at the
// collector's retention — asking for more than that can only return the
// same data under a misleading label.
func (s *Server) handleServerMetricsHistory(w http.ResponseWriter, r *http.Request) {
	id, err := serverIDFromRequest(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid server id")
		return
	}

	minutes := 60
	if raw := r.URL.Query().Get("minutes"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "minutes must be a positive integer")
			return
		}
		minutes = parsed
	}
	if maxMinutes := int(collector.Retention.Minutes()); minutes > maxMinutes {
		minutes = maxMinutes
	}

	since := time.Now().UTC().Add(-time.Duration(minutes) * time.Minute)
	samples, err := s.store.ListMetrics(r.Context(), id, since)
	if err != nil {
		s.logger.Error("loading metrics history", "server", id, "error", err)
		writeError(w, http.StatusInternalServerError, "failed to load metrics history")
		return
	}

	points := make([]metricPointDTO, 0, len(samples))
	for _, m := range samples {
		points = append(points, metricPointDTO{
			TS:          m.TS,
			PlayerCount: m.PlayerCount,
			MaxPlayers:  m.MaxPlayers,
			ServerFPS:   m.ServerFPS,
			FrameTime:   m.FrameTime,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"points": points,
		// Lets the chart tell a real gap in collection apart from samples
		// that are merely sparse.
		"intervalSeconds": int(collector.Interval.Seconds()),
	})
}

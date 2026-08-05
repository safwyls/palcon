package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/store"
)

func TestListServers(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	rec := app.do(t, "GET", "/api/servers", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("list on an empty install: %d (body %s)", rec.Code, rec.Body)
	}
	if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
		t.Errorf("an empty install should list an empty array, got %s", got)
	}

	createTestServer(t, app)
	createTestServer(t, app)
	rec = app.do(t, "GET", "/api/servers", nil, admin)
	var servers []struct {
		ID              int64  `json:"id"`
		Name            string `json:"name"`
		HasRCONPassword bool   `json:"hasRconPassword"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &servers); err != nil {
		t.Fatal(err)
	}
	if len(servers) != 2 {
		t.Fatalf("listed %d servers, want 2", len(servers))
	}
	// The DTO reports only whether a password is set, never the value.
	if strings.Contains(rec.Body.String(), "rconPassword\"") {
		t.Errorf("the list leaked a password field: %s", rec.Body)
	}
}

func TestListServersRequiresAuth(t *testing.T) {
	app, _ := newTestAppWithAdmin(t)
	if rec := app.do(t, "GET", "/api/servers", nil, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous list: %d, want 401", rec.Code)
	}
}

// Logging out clears the session cookie, and the cleared cookie really is
// rejected afterwards — expiring it client-side only would leave a working
// token in anyone's hands who copied it.
func TestLogoutClearsTheSession(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	rec := app.do(t, "POST", "/api/logout", nil, admin)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d (body %s)", rec.Code, rec.Body)
	}
	var cleared *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Value == "" {
			cleared = c
		}
	}
	if cleared == nil {
		t.Fatal("logout set no cleared cookie")
	}
	if !cleared.Expires.Before(time.Now()) {
		t.Errorf("the cleared cookie does not expire in the past: %v", cleared.Expires)
	}
	if !cleared.HttpOnly {
		t.Error("the session cookie must stay HttpOnly even when cleared")
	}

	if rec := app.do(t, "GET", "/api/me", nil, []*http.Cookie{cleared}); rec.Code != http.StatusUnauthorized {
		t.Errorf("the cleared cookie still authenticates: %d", rec.Code)
	}
}

// Client-side routes must survive a hard refresh: anything that isn't a real
// file falls back to index.html rather than 404ing.
func TestSPAFallback(t *testing.T) {
	app := newTestApp(t)

	for _, path := range []string{"/", "/servers/3", "/servers/3/players", "/login"} {
		req := httptest.NewRequest("GET", path, nil)
		rec := httptest.NewRecorder()
		app.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s: %d, want 200", path, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "<html>") {
			t.Errorf("GET %s did not serve the app shell: %s", path, rec.Body)
		}
	}
}

// An unknown /api path must not fall through to the SPA — an API client
// deserves a 404, not a page of HTML with a 200 on it.
func TestUnknownAPIPathIsNotTheSPA(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	rec := app.do(t, "GET", "/api/no-such-endpoint", nil, admin)
	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "<html>") {
		t.Errorf("an unknown API path served the SPA: %d %s", rec.Code, rec.Body)
	}
}

func TestMetricsHistory(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := createTestServer(t, app)
	base := "/api/servers/" + itoa(id)

	now := time.Now().UTC()
	intp := func(v int) *int { return &v }
	fp := func(v float64) *float64 { return &v }
	for i, m := range []store.MetricSample{
		{TS: now.Add(-30 * time.Minute), PlayerCount: intp(3), MaxPlayers: intp(32), ServerFPS: fp(58)},
		{TS: now.Add(-5 * time.Minute), PlayerCount: intp(5), MaxPlayers: intp(32), ServerFPS: fp(60)},
	} {
		if err := app.store.InsertMetric(context.Background(), id, m); err != nil {
			t.Fatalf("insert sample %d: %v", i, err)
		}
	}

	rec := app.do(t, "GET", base+"/metrics/history", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d (body %s)", rec.Code, rec.Body)
	}
	var res struct {
		Points []struct {
			PlayerCount int `json:"playerCount"`
		} `json:"points"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Points) != 2 {
		t.Fatalf("points = %d, want 2 (body %s)", len(res.Points), rec.Body)
	}

	// A narrow window excludes the older sample.
	rec = app.do(t, "GET", base+"/metrics/history?minutes=10", nil, admin)
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Points) != 1 {
		t.Errorf("a 10-minute window returned %d points, want 1", len(res.Points))
	}
}

func TestMetricsHistoryRejectsABadWindow(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	for _, q := range []string{"?minutes=0", "?minutes=-5", "?minutes=abc"} {
		if rec := app.do(t, "GET", base+"/metrics/history"+q, nil, admin); rec.Code != http.StatusBadRequest {
			t.Errorf("history%s: %d, want 400", q, rec.Code)
		}
	}
	// An oversized window is clamped to the retention period, not refused.
	if rec := app.do(t, "GET", base+"/metrics/history?minutes=999999", nil, admin); rec.Code != http.StatusOK {
		t.Errorf("an oversized window should clamp, not fail: %d", rec.Code)
	}
}

// Container power needs a docker endpoint. With none configured the feature
// is off rather than broken, and the message says which half is missing.
func TestContainerPowerWithoutDocker(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	rec := app.do(t, "GET", base+"/container", nil, admin)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("container status with no docker: %d (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "docker") {
		t.Errorf("the error should name the missing half: %s", rec.Body)
	}

	for _, action := range []string{"start", "stop", "restart"} {
		if rec := app.do(t, "POST", base+"/container/"+action, nil, admin); rec.Code != http.StatusBadRequest {
			t.Errorf("container %s with no docker: %d, want 400", action, rec.Code)
		}
	}
}

func TestDeleteUser(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	app.createUser(t, admin, "doomed", "doomedpass123", "user", nil)

	rec := app.do(t, "GET", "/api/users", nil, admin)
	var users []struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &users); err != nil {
		t.Fatal(err)
	}
	var doomedID, adminID int64
	for _, u := range users {
		switch u.Username {
		case "doomed":
			doomedID = u.ID
		case adminName:
			adminID = u.ID
		}
	}
	if doomedID == 0 || adminID == 0 {
		t.Fatalf("could not find both users: %+v", users)
	}

	if rec := app.do(t, "DELETE", "/api/users/"+itoa(doomedID), nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d (body %s)", rec.Code, rec.Body)
	}
	// The deleted account's credentials stop working.
	if rec := app.do(t, "POST", "/api/login",
		map[string]string{"username": "doomed", "password": "doomedpass123"}, nil); rec.Code == http.StatusOK {
		t.Error("a deleted user could still log in")
	}

	// Deleting yourself would lock the install out of its own admin.
	if rec := app.do(t, "DELETE", "/api/users/"+itoa(adminID), nil, admin); rec.Code == http.StatusNoContent {
		t.Error("an admin deleted their own account")
	}
	if rec := app.do(t, "DELETE", "/api/users/9999", nil, admin); rec.Code != http.StatusNotFound {
		t.Errorf("deleting a missing user: %d, want 404", rec.Code)
	}
	if rec := app.do(t, "DELETE", "/api/users/abc", nil, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("deleting a malformed id: %d, want 400", rec.Code)
	}
}

func TestDeleteUserIsAdminOnly(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	app.createUser(t, admin, "peon", "peonpass12345", "user", nil)
	app.createUser(t, admin, "target", "targetpass123", "user", nil)
	peon := app.login(t, "peon", "peonpass12345")

	if rec := app.do(t, "DELETE", "/api/users/2", nil, peon); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin delete: %d, want 403", rec.Code)
	}
}

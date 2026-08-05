package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// badBody posts raw text so the decoder's own failure path is exercised.
func badBody(t *testing.T, app *testApp, method, path string, cookies []*http.Cookie) int {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader("{not json"))
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	app.handler.ServeHTTP(rec, req)
	return rec.Code
}

func TestScheduleUpdateAndDelete(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	rec := app.do(t, "POST", base+"/schedules", map[string]any{
		"enabled": true, "days": []int{1, 3}, "timeOfDay": "05:00", "warningMinutes": []int{10},
	}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d (body %s)", rec.Code, rec.Body)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	path := base + "/schedules/" + itoa(created.ID)

	if rec := app.do(t, "PUT", path, map[string]any{
		"enabled": false, "days": []int{6}, "timeOfDay": "23:30", "warningMinutes": []int{5, 1},
	}, admin); rec.Code != http.StatusOK {
		t.Fatalf("update: %d (body %s)", rec.Code, rec.Body)
	}

	rec = app.do(t, "GET", base+"/automation", nil, admin)
	if !strings.Contains(rec.Body.String(), "23:30") {
		t.Errorf("the update did not stick: %s", rec.Body)
	}

	// Rejections
	if rec := app.do(t, "PUT", path, map[string]any{"timeOfDay": "25:99", "days": []int{1}}, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("an impossible time was accepted: %d", rec.Code)
	}
	if rec := app.do(t, "PUT", base+"/schedules/9999", map[string]any{
		"enabled": true, "days": []int{1}, "timeOfDay": "05:00",
	}, admin); rec.Code != http.StatusNotFound {
		t.Errorf("updating a missing schedule: %d, want 404", rec.Code)
	}
	if code := badBody(t, app, "PUT", path, admin); code != http.StatusBadRequest {
		t.Errorf("a malformed update body: %d, want 400", code)
	}

	if rec := app.do(t, "DELETE", path, nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d (body %s)", rec.Code, rec.Body)
	}
	// Delete is idempotent: the end state is the same either way, and a
	// double-click shouldn't produce an error.
	if rec := app.do(t, "DELETE", path, nil, admin); rec.Code != http.StatusNoContent {
		t.Errorf("deleting twice: %d, want 204", rec.Code)
	}
	if rec := app.do(t, "DELETE", base+"/schedules/abc", nil, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("deleting a malformed id: %d, want 400", rec.Code)
	}
}

// The watchdog is opt-in per server and has its own setter, so a
// server-edit form save can't silently switch it on or off.
func TestWatchdogToggleAndAvailability(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	if rec := app.do(t, "PUT", base+"/watchdog", map[string]any{"enabled": true}, admin); rec.Code != http.StatusOK {
		t.Fatalf("enable: %d (body %s)", rec.Code, rec.Body)
	}
	rec := app.do(t, "GET", base+"/automation", nil, admin)
	var res struct {
		Watchdog struct {
			Enabled   bool `json:"enabled"`
			Available bool `json:"available"`
		} `json:"watchdog"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if !res.Watchdog.Enabled {
		t.Errorf("the watchdog did not switch on: %s", rec.Body)
	}
	// Without docker control and a container name there is nothing to
	// revive, so the UI is told the feature isn't available.
	if res.Watchdog.Available {
		t.Error("the watchdog reported available with no docker configured")
	}

	if rec := app.do(t, "PUT", base+"/watchdog", map[string]any{"enabled": false}, admin); rec.Code != http.StatusOK {
		t.Fatalf("disable: %d", rec.Code)
	}
	if code := badBody(t, app, "PUT", base+"/watchdog", admin); code != http.StatusBadRequest {
		t.Errorf("a malformed watchdog body: %d, want 400", code)
	}
}

func TestDiscordConfigLifecycle(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	if rec := app.do(t, "PUT", base+"/discord", map[string]any{
		"webhookUrl": "https://discord.com/api/webhooks/1/abc",
		"enabled":    true, "onStatus": true, "onPlayers": false, "onRestarts": true,
	}, admin); rec.Code != http.StatusNoContent && rec.Code != http.StatusOK {
		t.Fatalf("configure: %d (body %s)", rec.Code, rec.Body)
	}

	rec := app.do(t, "GET", base+"/automation", nil, admin)
	body := rec.Body.String()
	// The URL is a secret the client only ever learns the existence of.
	if strings.Contains(body, "webhooks/1/abc") {
		t.Errorf("the automation payload echoed the webhook URL: %s", body)
	}

	if rec := app.do(t, "DELETE", base+"/discord", nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d (body %s)", rec.Code, rec.Body)
	}
	// Deleting again is harmless — the end state is the same either way.
	if rec := app.do(t, "DELETE", base+"/discord", nil, admin); rec.Code >= 500 {
		t.Errorf("deleting a missing webhook: %d", rec.Code)
	}
	if code := badBody(t, app, "PUT", base+"/discord", admin); code != http.StatusBadRequest {
		t.Errorf("a malformed discord body: %d, want 400", code)
	}
}

func TestBackupSettingsAndListing(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	if rec := app.do(t, "PUT", base+"/backups/settings",
		map[string]any{"intervalHours": 6, "keep": 5}, admin); rec.Code != http.StatusOK {
		t.Fatalf("settings: %d (body %s)", rec.Code, rec.Body)
	}

	rec := app.do(t, "GET", base+"/backups", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "\"intervalHours\":6") {
		t.Errorf("settings did not stick: %s", rec.Body)
	}

	if code := badBody(t, app, "PUT", base+"/backups/settings", admin); code != http.StatusBadRequest {
		t.Errorf("a malformed settings body: %d, want 400", code)
	}
	// Running a backup on a server with no save is a setup problem, not a
	// server error.
	if rec := app.do(t, "POST", base+"/backups/run", nil, admin); rec.Code >= 500 {
		t.Errorf("running a backup with no save: %d", rec.Code)
	}
	// Downloading and deleting something that was never made.
	if rec := app.do(t, "GET", base+"/backups/nope.zip/download", nil, admin); rec.Code != http.StatusNotFound {
		t.Errorf("downloading a missing snapshot: %d, want 404", rec.Code)
	}
	if rec := app.do(t, "DELETE", base+"/backups/nope.zip", nil, admin); rec.Code != http.StatusNotFound {
		t.Errorf("deleting a missing snapshot: %d, want 404", rec.Code)
	}
}

// The settings editor needs a readable config file; without one it says so
// rather than 500ing.
func TestConfigEndpointsWithoutAConfigPath(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	if rec := app.do(t, "GET", base+"/config", nil, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("GET config with none configured: %d, want 400", rec.Code)
	}
	if rec := app.do(t, "PUT", base+"/config",
		map[string]any{"settings": map[string]any{"ServerName": "x"}}, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("PUT config with none configured: %d, want 400", rec.Code)
	}
}

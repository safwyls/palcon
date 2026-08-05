package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/store"
)

// TestDiscord proves a pasted webhook works, so it is the one notification
// path that reports failure to the caller.
func TestDiscordTestEndpoint(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := createTestServer(t, app)
	base := "/api/servers/" + itoa(id)

	var mu sync.Mutex
	var posts, status = 0, http.StatusNoContent
	discord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		posts++
		code := status
		mu.Unlock()
		w.WriteHeader(code)
	}))
	t.Cleanup(discord.Close)

	// With nothing configured, the test says so rather than silently passing.
	if rec := app.do(t, "POST", base+"/discord/test", nil, admin); rec.Code == http.StatusNoContent {
		t.Error("testing an unconfigured webhook reported success")
	}

	// The store holds the URL; the API only ever learns whether one is set,
	// so the row is written directly here.
	if err := app.store.SetDiscordWebhook(context.Background(), &store.DiscordWebhook{
		ServerID: id, WebhookURL: discord.URL,
		Enabled: true, OnStatus: true, OnPlayers: true, OnRestarts: true,
	}); err != nil {
		t.Fatal(err)
	}

	if rec := app.do(t, "POST", base+"/discord/test", nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("test with a good webhook: %d (body %s)", rec.Code, rec.Body)
	}
	mu.Lock()
	got := posts
	mu.Unlock()
	if got != 1 {
		t.Errorf("posts = %d, want 1", got)
	}

	// A revoked webhook is a bad gateway: palcon works, Discord refused.
	mu.Lock()
	status = http.StatusNotFound
	mu.Unlock()
	if rec := app.do(t, "POST", base+"/discord/test", nil, admin); rec.Code != http.StatusBadGateway {
		t.Errorf("test with a revoked webhook: %d, want 502", rec.Code)
	}
}

func TestDiscordTestIsAdminOnly(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))
	app.createUser(t, admin, "peon", "peonpass12345", "user", nil)
	peon := app.login(t, "peon", "peonpass12345")

	if rec := app.do(t, "POST", base+"/discord/test", nil, peon); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin discord test: %d, want 403", rec.Code)
	}
}

// The public status page is the one unauthenticated endpoint, and it serves
// entirely from palcon's own database — never by probing the game.
func TestPublicStatus(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := createTestServer(t, app)
	base := "/api/servers/" + itoa(id)

	rec := app.do(t, "PUT", base+"/public", map[string]any{"enabled": true}, admin)
	if rec.Code != http.StatusOK && rec.Code != http.StatusNoContent {
		t.Fatalf("enabling the public page: %d (body %s)", rec.Code, rec.Body)
	}
	srv, err := app.store.GetServer(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if srv.PublicToken == "" {
		t.Fatal("enabling the public page minted no token")
	}

	// No cookies: this must work for someone without an account.
	rec = app.do(t, "GET", "/api/public/status/"+srv.PublicToken, nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("public status: %d (body %s)", rec.Code, rec.Body)
	}
	var res map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res["name"] != "main" {
		t.Errorf("public status = %v", res)
	}
	// With no samples yet, the server reads as offline rather than unknown.
	if res["online"] != false {
		t.Errorf("a server with no samples should read offline: %v", res)
	}
	// The page must never leak the things an account would see.
	body := rec.Body.String()
	for _, leak := range []string{"rconPassword", "restPassword", "agentToken", "host"} {
		if strings.Contains(body, leak) {
			t.Errorf("public status leaked %q: %s", leak, body)
		}
	}
}

func TestPublicStatusReflectsARecentSample(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := createTestServer(t, app)
	app.do(t, "PUT", "/api/servers/"+itoa(id)+"/public", map[string]any{"enabled": true}, admin)
	srv, _ := app.store.GetServer(context.Background(), id)

	players, maxPlayers := 4, 32
	if err := app.store.InsertMetric(context.Background(), id, store.MetricSample{
		TS: time.Now().UTC(), PlayerCount: &players, MaxPlayers: &maxPlayers,
	}); err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "GET", "/api/public/status/"+srv.PublicToken, nil, nil)
	var res map[string]any
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res["online"] != true {
		t.Errorf("a fresh sample should read online: %v", res)
	}
	if res["players"] != float64(4) || res["maxPlayers"] != float64(32) {
		t.Errorf("player counts = %v", res)
	}
}

func TestPublicStatusUnknownToken(t *testing.T) {
	app, _ := newTestAppWithAdmin(t)
	if rec := app.do(t, "GET", "/api/public/status/nosuchtoken", nil, nil); rec.Code != http.StatusNotFound {
		t.Errorf("unknown token: %d, want 404", rec.Code)
	}
}

// The visibility payload is the whole state each time, so two admins editing
// at once can't merge into a combination neither chose.
func TestVisibilityReplacesTheWholeState(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	put := func(body any) *httptest.ResponseRecorder {
		return app.do(t, "PUT", base+"/visibility", body, admin)
	}

	if rec := put(map[string]any{
		"hiddenFeatures":     []string{"map", "inventory"},
		"hidePrivateStorage": true,
		"players":            map[string][]string{"uid-1": {"map"}},
	}); rec.Code != http.StatusNoContent {
		t.Fatalf("first put: %d (body %s)", rec.Code, rec.Body)
	}

	rec := app.do(t, "GET", base+"/visibility", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d (body %s)", rec.Code, rec.Body)
	}
	var got struct {
		HiddenFeatures     []string            `json:"hiddenFeatures"`
		HidePrivateStorage bool                `json:"hidePrivateStorage"`
		Players            map[string][]string `json:"players"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.HiddenFeatures) != 2 || !got.HidePrivateStorage {
		t.Errorf("visibility = %+v", got)
	}
	if len(got.Players["uid-1"]) != 1 {
		t.Errorf("player visibility = %+v", got.Players)
	}

	// A player omitted from a later payload is one nobody is hiding any more.
	if rec := put(map[string]any{
		"hiddenFeatures":     []string{},
		"hidePrivateStorage": false,
		"players":            map[string][]string{},
	}); rec.Code != http.StatusNoContent {
		t.Fatalf("second put: %d (body %s)", rec.Code, rec.Body)
	}
	// A fresh destination: Unmarshal merges into an existing non-nil map
	// rather than replacing it, which would hide exactly the bug this
	// assertion is looking for.
	var after struct {
		HiddenFeatures     []string            `json:"hiddenFeatures"`
		HidePrivateStorage bool                `json:"hidePrivateStorage"`
		Players            map[string][]string `json:"players"`
	}
	rec = app.do(t, "GET", base+"/visibility", nil, admin)
	if err := json.Unmarshal(rec.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if len(after.HiddenFeatures) != 0 || after.HidePrivateStorage {
		t.Errorf("switches survived a clearing payload: %+v", after)
	}
	if len(after.Players) != 0 {
		t.Errorf("an omitted player stayed hidden: %+v", after.Players)
	}
}

func TestVisibilityRejectsAMalformedBody(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	base := "/api/servers/" + itoa(createTestServer(t, app))

	req := httptest.NewRequest("PUT", "/api"+strings.TrimPrefix(base, "/api")+"/visibility", strings.NewReader("{nope"))
	for _, c := range admin {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	app.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("malformed visibility payload: %d, want 400", rec.Code)
	}
}

func TestUpdateUser(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	app.createUser(t, admin, "editme", "editmepass123", "user", nil)

	rec := app.do(t, "GET", "/api/users", nil, admin)
	var users []struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	}
	json.Unmarshal(rec.Body.Bytes(), &users)
	var id int64
	for _, u := range users {
		if u.Username == "editme" {
			id = u.ID
		}
	}
	if id == 0 {
		t.Fatalf("could not find the user: %+v", users)
	}

	// Granting a permission takes effect on the next request.
	if rec := app.do(t, "PUT", "/api/users/"+itoa(id), map[string]any{
		"role": "user", "permissions": []string{store.PermBroadcast},
	}, admin); rec.Code != http.StatusOK {
		t.Fatalf("update: %d (body %s)", rec.Code, rec.Body)
	}

	// A password change invalidates the old one.
	if rec := app.do(t, "PUT", "/api/users/"+itoa(id), map[string]any{
		"role": "user", "password": "brandnewpass123",
	}, admin); rec.Code != http.StatusOK {
		t.Fatalf("password update: %d (body %s)", rec.Code, rec.Body)
	}
	if rec := app.do(t, "POST", "/api/login",
		map[string]string{"username": "editme", "password": "editmepass123"}, nil); rec.Code == http.StatusOK {
		t.Error("the old password still works after a change")
	}
	app.login(t, "editme", "brandnewpass123")

	if rec := app.do(t, "PUT", "/api/users/9999", map[string]any{"role": "user"}, admin); rec.Code != http.StatusNotFound {
		t.Errorf("updating a missing user: %d, want 404", rec.Code)
	}
	if rec := app.do(t, "PUT", "/api/users/abc", map[string]any{"role": "user"}, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("updating a malformed id: %d, want 400", rec.Code)
	}
}

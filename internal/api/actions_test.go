package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/safwyls/palcon/internal/store"
)

// fakeGame is a Palworld REST API just complete enough for the action
// handlers: it records what was asked of it so tests can assert the request
// actually reached the game, and can be told to fail so the 502 path is
// exercised too.
type fakeGame struct {
	mu    sync.Mutex
	calls []string
	// bodies keeps the last decoded payload per path.
	bodies map[string]map[string]any
	fail   bool
	//

	players []map[string]any
}

func newFakeGame(t *testing.T) (*fakeGame, string) {
	t.Helper()
	f := &fakeGame{
		bodies: map[string]map[string]any{},
		players: []map[string]any{
			{"name": "Ada", "playerId": "p1", "userId": "steam_1", "level": 42, "location_x": 100.0, "location_y": 200.0},
		},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		if r.Body != nil {
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) == nil {
				f.bodies[r.URL.Path] = body
			}
		}
		fail, players := f.fail, f.players
		f.mu.Unlock()

		if fail {
			http.Error(w, "the server exploded", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/api/info":
			json.NewEncoder(w).Encode(map[string]any{"servername": "Palhalla", "version": "0.3.2"})
		case "/v1/api/players":
			json.NewEncoder(w).Encode(map[string]any{"players": players})
		case "/v1/api/settings":
			json.NewEncoder(w).Encode(map[string]any{"ServerName": "Palhalla", "Difficulty": "None"})
		case "/v1/api/metrics":
			json.NewEncoder(w).Encode(map[string]any{"serverfps": 60, "currentplayernum": 1, "uptime": 3600})
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	return f, srv.URL
}

func (f *fakeGame) saw(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Contains(strings.Join(f.calls, " | "), path)
}

func (f *fakeGame) body(path string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[path]
}

func (f *fakeGame) setFail(v bool) {
	f.mu.Lock()
	f.fail = v
	f.mu.Unlock()
}

// newServerPointingAt registers a REST-mode server row aimed at the fake.
func newServerPointingAt(t *testing.T, app *testApp, rawURL string, over func(*store.Server)) int64 {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	srv := &store.Server{
		Name: "Palhalla", Host: u.Hostname(),
		RESTPort: port, RESTPassword: "restpw",
		RCONPort: 25575, RCONPassword: "rconpw",
		UseREST: true, Enabled: true,
	}
	if over != nil {
		over(srv)
	}
	id, err := app.store.CreateServer(context.Background(), srv)
	if err != nil {
		t.Fatalf("create server: %v", err)
	}
	return id
}

func TestServerInfoAndPlayers(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	fake, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))

	rec := app.do(t, "GET", base+"/info", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("info: %d (body %s)", rec.Code, rec.Body)
	}
	var info struct {
		ServerName  string `json:"servername"`
		PlayerCount int    `json:"playerCount"`
		Transport   string `json:"transport"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.ServerName != "Palhalla" || info.Transport != "rest" || info.PlayerCount != 1 {
		t.Errorf("info = %+v", info)
	}

	rec = app.do(t, "GET", base+"/players", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("players: %d (body %s)", rec.Code, rec.Body)
	}
	var players []struct {
		Name      string  `json:"name"`
		LocationX float64 `json:"location_x"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &players); err != nil {
		t.Fatal(err)
	}
	if len(players) != 1 || players[0].Name != "Ada" {
		t.Fatalf("players = %+v", players)
	}
	// An admin on a map-enabled server sees coordinates.
	if players[0].LocationX == 0 {
		t.Errorf("coordinates were blanked for an admin on a visible map")
	}
	if !fake.saw("/v1/api/info") || !fake.saw("/v1/api/players") {
		t.Errorf("the game was never asked: %v", fake.calls)
	}
}

// Coordinates are the private half of the player list. The names and levels
// stay — the dashboard's online list reads the same endpoint.
func TestServerPlayersBlanksCoordinatesWhenMapIsOff(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	_, addr := newFakeGame(t)
	id := newServerPointingAt(t, app, addr, nil)
	if rec := app.do(t, "PUT", "/api/servers/"+itoa(id)+"/visibility",
		map[string]any{"hiddenFeatures": []string{"map"}}, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("hiding the map: %d (body %s)", rec.Code, rec.Body)
	}

	// A non-admin must not get coordinates for a server with the map off.
	app.createUser(t, admin, "viewer", "viewerpass123", "user", nil)
	viewer := app.login(t, "viewer", "viewerpass123")

	rec := app.do(t, "GET", "/api/servers/"+itoa(id)+"/players", nil, viewer)
	if rec.Code != http.StatusOK {
		t.Fatalf("players: %d (body %s)", rec.Code, rec.Body)
	}
	var players []struct {
		Name      string  `json:"name"`
		LocationX float64 `json:"location_x"`
		LocationY float64 `json:"location_y"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &players); err != nil {
		t.Fatal(err)
	}
	if len(players) != 1 {
		t.Fatalf("players = %+v", players)
	}
	if players[0].Name != "Ada" {
		t.Errorf("the name is not the private part, but it went: %+v", players[0])
	}
	if players[0].LocationX != 0 || players[0].LocationY != 0 {
		t.Errorf("coordinates survived with the map switched off: %+v", players[0])
	}
}

func TestServerModerationActions(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	fake, addr := newFakeGame(t)
	id := newServerPointingAt(t, app, addr, nil)
	base := "/api/servers/" + itoa(id)

	cases := []struct {
		name, path, gamePath string
		body                 any
		wantAudit            string
	}{
		{"broadcast", "/broadcast", "/v1/api/announce", map[string]any{"message": "hello"}, "broadcast"},
		{"kick", "/kick", "/v1/api/kick", map[string]any{"playerUid": "p1", "message": "bye"}, "kick"},
		{"ban", "/ban", "/v1/api/ban", map[string]any{"playerUid": "p1", "message": "cheating"}, "ban"},
		{"unban", "/unban", "/v1/api/unban", map[string]any{"playerUid": "p1"}, "unban"},
		{"save", "/save", "/v1/api/save", nil, "save-world"},
		{"shutdown", "/shutdown", "/v1/api/shutdown", map[string]any{"waitSeconds": 30, "message": "night"}, "shutdown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := app.do(t, "POST", base+tc.path, tc.body, admin)
			if rec.Code != http.StatusNoContent {
				t.Fatalf("%s: %d (body %s)", tc.name, rec.Code, rec.Body)
			}
			if !fake.saw(tc.gamePath) {
				t.Errorf("%s never reached the game: %v", tc.name, fake.calls)
			}
		})
	}

	// Every action lands in the audit trail, which is the record of who did
	// what to a live server.
	rec := app.do(t, "GET", base+"/audit", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d (body %s)", rec.Code, rec.Body)
	}
	trail := rec.Body.String()
	for _, tc := range cases {
		if !strings.Contains(trail, tc.wantAudit) {
			t.Errorf("audit trail is missing %q: %s", tc.wantAudit, trail)
		}
	}
}

func TestServerActionsPassThroughTheirArguments(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	fake, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))

	app.do(t, "POST", base+"/broadcast", map[string]any{"message": "server restarting"}, admin)
	if got := fake.body("/v1/api/announce")["message"]; got != "server restarting" {
		t.Errorf("announce message = %v", got)
	}

	app.do(t, "POST", base+"/kick", map[string]any{"playerUid": "steam_9", "message": "afk"}, admin)
	if got := fake.body("/v1/api/kick")["userid"]; got != "steam_9" {
		t.Errorf("kick userid = %v", got)
	}

	app.do(t, "POST", base+"/shutdown", map[string]any{"waitSeconds": 45, "message": "patch"}, admin)
	body := fake.body("/v1/api/shutdown")
	if body["waittime"] != float64(45) && body["waitTime"] != float64(45) {
		t.Errorf("shutdown body did not carry the wait: %v", body)
	}
}

// A game that answers with an error is a bad gateway, not a 500: palcon is
// working, the thing behind it isn't.
func TestServerActionsReportGameFailureAsBadGateway(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	fake, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))
	fake.setFail(true)

	for _, path := range []string{"/info", "/players", "/settings", "/metrics"} {
		if rec := app.do(t, "GET", base+path, nil, admin); rec.Code != http.StatusBadGateway {
			t.Errorf("GET %s: %d, want 502", path, rec.Code)
		}
	}
	for _, tc := range []struct {
		path string
		body any
	}{
		{"/broadcast", map[string]any{"message": "x"}},
		{"/kick", map[string]any{"playerUid": "p"}},
		{"/ban", map[string]any{"playerUid": "p"}},
		{"/unban", map[string]any{"playerUid": "p"}},
		{"/save", nil},
		{"/shutdown", map[string]any{"waitSeconds": 1}},
	} {
		if rec := app.do(t, "POST", base+tc.path, tc.body, admin); rec.Code != http.StatusBadGateway {
			t.Errorf("POST %s: %d, want 502", tc.path, rec.Code)
		}
	}
}

func TestServerActionsRejectMalformedBodies(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	_, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))

	for _, path := range []string{"/broadcast", "/kick", "/ban", "/unban", "/shutdown"} {
		req := httptest.NewRequest("POST", "/api"+strings.TrimPrefix(base, "/api")+path, strings.NewReader("{not json"))
		for _, c := range admin {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		app.handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s with a broken body: %d, want 400", path, rec.Code)
		}
	}
}

func TestServerActionsOnAMissingServer(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/servers/999/info"},
		{"GET", "/api/servers/999/players"},
		{"GET", "/api/servers/999/settings"},
		{"GET", "/api/servers/999/metrics"},
		{"POST", "/api/servers/999/save"},
	} {
		var body any
		if tc.method == "POST" {
			body = map[string]any{}
		}
		if rec := app.do(t, tc.method, tc.path, body, admin); rec.Code != http.StatusNotFound {
			t.Errorf("%s %s: %d, want 404", tc.method, tc.path, rec.Code)
		}
	}
}

// Settings and metrics need the REST API; an RCON-only row can't serve them,
// and saying so is more useful than a generic failure.
func TestSettingsAndMetricsNeedREST(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	_, addr := newFakeGame(t)
	id := newServerPointingAt(t, app, addr, func(s *store.Server) { s.UseREST = false })
	base := "/api/servers/" + itoa(id)

	for _, path := range []string{"/settings", "/metrics"} {
		rec := app.do(t, "GET", base+path, nil, admin)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("GET %s on an RCON-only server: %d, want 400 (body %s)", path, rec.Code, rec.Body)
		}
		if !strings.Contains(rec.Body.String(), "RCON-only") {
			t.Errorf("the error should explain which half is missing: %s", rec.Body)
		}
	}
}

func TestSettingsAndMetricsOverREST(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	_, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))

	rec := app.do(t, "GET", base+"/settings", nil, admin)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Palhalla") {
		t.Fatalf("settings: %d (body %s)", rec.Code, rec.Body)
	}

	rec = app.do(t, "GET", base+"/metrics", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("metrics: %d (body %s)", rec.Code, rec.Body)
	}
	var m struct {
		ServerFPS int `json:"serverfps"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	if m.ServerFPS != 60 {
		t.Errorf("metrics = %+v", m)
	}
}

// The moderation verbs are permission-gated; a user without the permission
// is refused before anything reaches the game.
func TestServerActionPermissions(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	fake, addr := newFakeGame(t)
	base := "/api/servers/" + itoa(newServerPointingAt(t, app, addr, nil))

	app.createUser(t, admin, "plain", "plainpass123", "user", nil)
	plain := app.login(t, "plain", "plainpass123")

	for _, tc := range []struct {
		path string
		body any
	}{
		{"/broadcast", map[string]any{"message": "x"}},
		{"/kick", map[string]any{"playerUid": "p"}},
		{"/ban", map[string]any{"playerUid": "p"}},
		{"/unban", map[string]any{"playerUid": "p"}},
		{"/save", nil},
		{"/shutdown", map[string]any{"waitSeconds": 1}},
	} {
		if rec := app.do(t, "POST", base+tc.path, tc.body, plain); rec.Code != http.StatusForbidden {
			t.Errorf("POST %s without permission: %d, want 403", tc.path, rec.Code)
		}
	}
	for _, called := range []string{"/v1/api/announce", "/v1/api/kick", "/v1/api/ban", "/v1/api/save"} {
		if fake.saw(called) {
			t.Errorf("a refused request still reached the game: %s", called)
		}
	}
}

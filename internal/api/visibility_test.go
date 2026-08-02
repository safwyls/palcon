package api_test

import (
	"net/http"
	"testing"
)

// makeMember creates a non-admin account and returns its session, for checking
// the half of visibility that admins don't experience.
func makeMember(t *testing.T, app *testApp, admin []*http.Cookie) []*http.Cookie {
	t.Helper()
	rec := app.do(t, "POST", "/api/users", map[string]any{
		"username": "member", "password": "member-password-1", "role": "member",
	}, admin)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("create member: got %d (body %s)", rec.Code, rec.Body)
	}
	return app.login(t, "member", "member-password-1")
}

func newServerForVisibility(t *testing.T, app *testApp, admin []*http.Cookie) {
	t.Helper()
	rec := app.do(t, "POST", "/api/servers", map[string]any{
		"name": "s1", "host": "10.0.0.1", "rconPort": 25575, "rconPassword": "x",
	}, admin)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("create server: got %d (body %s)", rec.Code, rec.Body)
	}
}

func TestVisibilityIsAdminOnly(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	newServerForVisibility(t, app, admin)
	member := makeMember(t, app, admin)

	// The list of who asked to be hidden is itself the sort of thing the
	// hiding is meant to keep quiet, so reading it is admin-only too.
	if rec := app.do(t, "GET", "/api/servers/1/visibility", nil, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member GET visibility: got %d, want 403", rec.Code)
	}
	if rec := app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{"inventory"},
	}, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member PUT visibility: got %d, want 403", rec.Code)
	}
	if rec := app.do(t, "GET", "/api/servers/1/visibility", nil, admin); rec.Code != http.StatusOK {
		t.Fatalf("admin GET visibility: got %d, want 200 (body %s)", rec.Code, rec.Body)
	}
}

func TestHiddenFeatureRefusesMembersButNotAdmins(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	newServerForVisibility(t, app, admin)
	member := makeMember(t, app, admin)

	rec := app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{"inventory"},
		"players":        map[string][]string{},
	}, admin)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("save visibility: got %d (body %s)", rec.Code, rec.Body)
	}

	// A member is refused before the save is even looked for: the point is
	// that the data never leaves, not that it fails for another reason.
	if rec := app.do(t, "GET", "/api/servers/1/inventory", nil, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member GET inventory: got %d, want 403 (body %s)", rec.Code, rec.Body)
	}

	// The admin gets past the gate and fails on the missing save path instead,
	// which is what "admins bypass" has to mean to be worth anything.
	rec = app.do(t, "GET", "/api/servers/1/inventory", nil, admin)
	if rec.Code == http.StatusForbidden {
		t.Fatal("admin was refused a view they turned off; admins are supposed to bypass")
	}

	// A view left on is unaffected by another being off.
	if rec := app.do(t, "GET", "/api/servers/1/pals", nil, member); rec.Code == http.StatusForbidden {
		t.Fatal("hiding inventory also hid pals")
	}
}

func TestStorageIsItsOwnSwitch(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	newServerForVisibility(t, app, admin)
	member := makeMember(t, app, admin)

	app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{"storage"},
		"players":        map[string][]string{},
	}, admin)

	if rec := app.do(t, "GET", "/api/servers/1/storage", nil, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member GET storage: got %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	// Asking for world loot must not be a way around the switch.
	if rec := app.do(t, "GET", "/api/servers/1/storage?world=1", nil, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member GET storage?world=1: got %d, want 403 (body %s)", rec.Code, rec.Body)
	}
	if rec := app.do(t, "GET", "/api/servers/1/storage", nil, admin); rec.Code == http.StatusForbidden {
		t.Fatal("admin was refused a view they turned off; admins are supposed to bypass")
	}
	// Storage and inventory read the same parse but answer different views, so
	// hiding one must leave the other standing.
	if rec := app.do(t, "GET", "/api/servers/1/inventory", nil, member); rec.Code == http.StatusForbidden {
		t.Fatal("hiding storage also hid inventory")
	}
}

func TestHidingEveryPalsViewClosesTheSharedEndpoint(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	newServerForVisibility(t, app, admin)
	member := makeMember(t, app, admin)

	// /pals answers three views. Switching one off must not close it...
	app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{"pals"},
	}, admin)
	if rec := app.do(t, "GET", "/api/servers/1/pals", nil, member); rec.Code == http.StatusForbidden {
		t.Fatal("Paldex and Calculators still need /pals")
	}

	// ...but switching off all three must, or the payload would still be a
	// download away from anyone who noticed.
	app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{"pals", "paldex", "calculators"},
	}, admin)
	if rec := app.do(t, "GET", "/api/servers/1/pals", nil, member); rec.Code != http.StatusForbidden {
		t.Fatalf("member GET pals with every view off: got %d, want 403", rec.Code)
	}
}

func TestVisibilityPutReplacesWholeState(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	newServerForVisibility(t, app, admin)
	const uid = "11111111-1111-1111-1111-111111111111"

	app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{},
		"players":        map[string][]string{uid: {"inventory"}},
	}, admin)

	// An omitted player is one nobody is hiding any more — otherwise a hide
	// could only ever be added, never lifted.
	app.do(t, "PUT", "/api/servers/1/visibility", map[string]any{
		"hiddenFeatures": []string{},
		"players":        map[string][]string{},
	}, admin)

	rec := app.do(t, "GET", "/api/servers/1/visibility", nil, admin)
	got := decodeMap(t, rec)
	players, _ := got["players"].(map[string]any)
	if len(players) != 0 {
		t.Fatalf("player hides survived a replacing PUT: %v", players)
	}
}

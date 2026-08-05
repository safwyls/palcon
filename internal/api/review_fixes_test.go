package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/store"
)

// supervisorAgent is a palagent reporting supervisor mode with the game in
// whatever state a test needs.
func supervisorAgent(t *testing.T, gameState string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v1/health":
			json.NewEncoder(w).Encode(map[string]any{
				"agent": "palagent", "mode": "supervisor", "apiVersion": 1,
				"installDir": "/palworld", "installDirOk": true,
				"game": map[string]any{"state": gameState},
			})
		case strings.HasPrefix(r.URL.Path, "/v1/steam/update"):
			json.NewEncoder(w).Encode(map[string]any{"job": map[string]any{"id": "j1", "state": "running"}})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// A supervised container runs palagent as PID 1, so it is always up even
// with the game stopped. Reading container state there would refuse every
// update forever — and stopping the container to satisfy the gate kills the
// agent that has to perform the update.
func TestSteamUpdateAsksTheAgentNotTheContainer(t *testing.T) {
	fake, docker := newDockerFake(t) // reports the container running
	app, admin := newTestAppWithDocker(t, docker)

	id, err := app.store.CreateServer(context.Background(), &store.Server{
		Name: "supervised", Host: "10.0.0.5", Enabled: true,
		RCONPort: 25575, RESTPort: 8212,
		ContainerName: "palagent-main",
		AgentURL:      supervisorAgent(t, "stopped"),
		AgentToken:    "agent-token-0123456789abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "POST", "/api/servers/"+itoa(id)+"/steam/update", map[string]any{"validate": true}, admin)
	if rec.Code != http.StatusAccepted && rec.Code != http.StatusOK {
		t.Fatalf("update on a stopped game in a running container: %d (body %s)", rec.Code, rec.Body)
	}
	if fake.saw("/json") {
		t.Errorf("the container was inspected for a server the agent supervises: %v", fake.actions)
	}
}

// The gate itself still holds — it just reads the game's state now.
func TestSteamUpdateRefusedWhileTheSupervisedGameRuns(t *testing.T) {
	_, docker := newDockerFake(t)
	app, admin := newTestAppWithDocker(t, docker)

	id, err := app.store.CreateServer(context.Background(), &store.Server{
		Name: "supervised", Host: "10.0.0.5", Enabled: true,
		RCONPort: 25575, RESTPort: 8212,
		ContainerName: "palagent-main",
		AgentURL:      supervisorAgent(t, "running"),
		AgentToken:    "agent-token-0123456789abcdef",
	})
	if err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "POST", "/api/servers/"+itoa(id)+"/steam/update", map[string]any{}, admin)
	if rec.Code != http.StatusConflict {
		t.Fatalf("update while the game runs: %d (body %s), want 409", rec.Code, rec.Body)
	}
}

// destroyStub is a provisioner that answers destroy however a test needs.
type destroyStub struct {
	mu     sync.Mutex
	status int
	body   string
	calls  int
}

func newDestroyStub(t *testing.T) (*destroyStub, string) {
	t.Helper()
	d := &destroyStub{status: http.StatusOK, body: `{"container":"palagent-main","dataDir":"/data/main"}`}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/health" {
			json.NewEncoder(w).Encode(map[string]any{
				"agent": "palagent", "mode": "provisioner", "apiVersion": 1,
				"provision": map[string]any{"dataRoot": "/data", "runAs": "568:568", "imageTag": "latest"},
			})
			return
		}
		d.mu.Lock()
		d.calls++
		status, body := d.status, d.body
		d.mu.Unlock()
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return d, srv.URL
}

func (d *destroyStub) set(status int, body string) {
	d.mu.Lock()
	d.status, d.body = status, body
	d.mu.Unlock()
}

// The retry trap: once the container is gone but the row survives — a
// hand-run docker rm, or a destroy that succeeded before the row delete
// failed — every retry hit the provisioner's 404 and 400'd forever, so the
// row could only be removed by unchecking the very option that was asked
// for. "Already gone" is the end state that was wanted; proceed.
func TestDeleteTreatsAnAlreadyGoneContainerAsDestroyed(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	stub, provURL := newDestroyStub(t)
	withProvisioner(t, app, provURL)

	id := addProvisionedRow(t, app, "palagent-main")
	stub.set(http.StatusNotFound, `{"error":"no container with that name"}`)

	rec := app.do(t, "DELETE", "/api/servers/"+itoa(id)+"?removeContainer=true", nil, admin)
	if rec.Code != http.StatusOK && rec.Code != http.StatusNoContent {
		t.Fatalf("destroying an already-gone container: %d (body %s)", rec.Code, rec.Body)
	}
	if rec := app.do(t, "GET", "/api/servers/"+itoa(id), nil, admin); rec.Code != http.StatusNotFound {
		t.Errorf("the row survived: %d", rec.Code)
	}
}

// A refusal is not "already gone" and must still stop the delete.
func TestDeleteStillStopsOnARefusedDestroy(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	stub, provURL := newDestroyStub(t)
	withProvisioner(t, app, provURL)

	id := addProvisionedRow(t, app, "palagent-byhand")
	stub.set(http.StatusBadRequest, `{"error":"that container was not created by this provisioner"}`)

	if rec := app.do(t, "DELETE", "/api/servers/"+itoa(id)+"?removeContainer=true", nil, admin); rec.Code != http.StatusBadRequest {
		t.Fatalf("refused destroy: %d (body %s), want 400", rec.Code, rec.Body)
	}
	if rec := app.do(t, "GET", "/api/servers/"+itoa(id), nil, admin); rec.Code != http.StatusOK {
		t.Errorf("the row was deleted despite the refusal: %d", rec.Code)
	}
}

// Two rows can name one container (adopt doesn't check, the edit form takes
// any name). Destroying for one would unmake the other's server.
func TestDeleteRefusesToDestroyASharedContainer(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	stub, provURL := newDestroyStub(t)
	withProvisioner(t, app, provURL)

	first := addProvisionedRow(t, app, "palagent-shared")
	addProvisionedRow(t, app, "palagent-shared")

	rec := app.do(t, "DELETE", "/api/servers/"+itoa(first)+"?removeContainer=true", nil, admin)
	if rec.Code != http.StatusConflict {
		t.Fatalf("destroying a shared container: %d (body %s), want 409", rec.Code, rec.Body)
	}
	stub.mu.Lock()
	calls := stub.calls
	stub.mu.Unlock()
	if calls != 0 {
		t.Errorf("the provisioner was asked to destroy a shared container")
	}
	// Removing just the row is still allowed — that's the way out.
	if rec := app.do(t, "DELETE", "/api/servers/"+itoa(first), nil, admin); rec.Code != http.StatusNoContent {
		t.Errorf("plain delete of a shared-container row: %d", rec.Code)
	}
}

// A plain delete stays idempotent: the store's DELETE succeeds on zero
// rows, so a retry or the loser of two concurrent deletes gets 204, not a
// 404 that reads as failure to a script built against the old behaviour.
func TestPlainDeleteIsIdempotent(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := itoa(createTestServer(t, app))

	if rec := app.do(t, "DELETE", "/api/servers/"+id, nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("first delete: %d", rec.Code)
	}
	if rec := app.do(t, "DELETE", "/api/servers/"+id, nil, admin); rec.Code != http.StatusNoContent {
		t.Errorf("second delete: %d, want 204 — the endpoint used to be idempotent", rec.Code)
	}
	if rec := app.do(t, "DELETE", "/api/servers/999999", nil, admin); rec.Code != http.StatusNoContent {
		t.Errorf("delete of a never-existing row: %d, want 204", rec.Code)
	}
	// A malformed id is still a client error.
	if rec := app.do(t, "DELETE", "/api/servers/abc", nil, admin); rec.Code != http.StatusBadRequest {
		t.Errorf("malformed id: %d, want 400", rec.Code)
	}
}

// withProvisioner points the app's provisioner client at url.
func withProvisioner(t *testing.T, app *testApp, url string) {
	t.Helper()
	client, err := agentctl.New(url, "prov-token-0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	app.api.Provisioner = client
}

// addProvisionedRow registers a row shaped like a one-click deploy.
func addProvisionedRow(t *testing.T, app *testApp, container string) int64 {
	t.Helper()
	id, err := app.store.CreateServer(context.Background(), &store.Server{
		Name: "provisioned", Host: "10.0.0.5", Enabled: true,
		RCONPort: 25575, RESTPort: 8212, ContainerName: container,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

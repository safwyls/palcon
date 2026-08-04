package palagent_test

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/safwyls/palcon/internal/palagent"
)

// fakeDockerAPI records the provisioner's docker calls.
type fakeDockerAPI struct {
	calls  []string
	create map[string]any
}

func (f *fakeDockerAPI) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls = append(f.calls, r.Method+" "+r.URL.Path)
		switch {
		case r.URL.Path == "/images/create":
			w.Write([]byte(`{"status":"done"}` + "\n"))
		case r.URL.Path == "/containers/create":
			json.NewDecoder(r.Body).Decode(&f.create)
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"Id":"deadbeef"}`))
		case r.URL.Path == "/containers/json":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[
			  {"Id":"c1","Names":["/palagent-main"],"Image":"ghcr.io/safwyls/palagent:beta","State":"running",
			   "Labels":{"palcon.provisioned":"true","palcon.slug":"main"},
			   "Ports":[{"PrivatePort":8211,"PublicPort":9211,"Type":"udp"},{"PrivatePort":8811,"PublicPort":9811,"Type":"tcp"},{"PrivatePort":8212,"PublicPort":9212,"Type":"tcp"}]},
			  {"Id":"c2","Names":["/palprovisioner"],"Image":"ghcr.io/safwyls/palagent:beta","State":"running","Ports":[]},
			  {"Id":"c3","Names":["/nginx"],"Image":"nginx:latest","State":"running","Ports":[]}
			]`))
		case r.URL.Path == "/containers/c1/json":
			w.Write([]byte(`{"Config":{"Env":["PALAGENT_MODE=supervisor","PALAGENT_TOKEN=secret-must-not-leak","PALAGENT_ADMIN_PASSWORD=recovered-pw","PALAGENT_SERVER_NAME=Main World"]}}`))
		case r.URL.Path == "/containers/c2/json":
			w.Write([]byte(`{"Config":{"Env":["PALAGENT_MODE=provisioner"]}}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
}

func newProvisioner(t *testing.T) (*httptest.Server, *fakeDockerAPI, string) {
	t.Helper()
	fake := &fakeDockerAPI{}
	dockerSrv := httptest.NewServer(fake.handler())
	t.Cleanup(dockerSrv.Close)
	dataRoot := t.TempDir()
	agent, err := palagent.New(palagent.Config{
		Token: testToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: dataRoot,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(agent.Handler())
	t.Cleanup(srv.Close)
	return srv, fake, dataRoot
}

func TestProvisionerCreatesServer(t *testing.T) {
	srv, fake, dataRoot := newProvisioner(t)

	resp, m := do(t, srv, "POST", "/v1/provision", testToken, map[string]any{
		"slug": "palhalla-2", "imageTag": "beta",
		"token": "new-agent-token-0123456789abcdef", "adminPassword": "pw12345",
		"serverName": "Palhalla II", "serverDesc": "chill server", "runAs": "568:568",
		"gamePort": 9211, "restPort": 9212, "rconPort": 9575, "agentPort": 9811,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("provision: %d %v", resp.StatusCode, m)
	}
	if m["container"] != "palagent-palhalla-2" || m["dataDir"] != filepath.Join(dataRoot, "palhalla-2") {
		t.Errorf("response = %v", m)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "palhalla-2")); err != nil {
		t.Errorf("data dir not created: %v", err)
	}

	// pull → create → start, template locked to the palagent image.
	joined := strings.Join(fake.calls, " | ")
	for _, want := range []string{"/images/create", "/containers/create", "/start"} {
		if !strings.Contains(joined, want) {
			t.Errorf("docker calls missing %s: %s", want, joined)
		}
	}
	if fake.create["Image"] != "ghcr.io/safwyls/palagent:beta" || fake.create["User"] != "568:568" {
		t.Errorf("create = image %v user %v", fake.create["Image"], fake.create["User"])
	}
	env := strings.Join(toStrings(fake.create["Env"].([]any)), " ")
	for _, want := range []string{"PALAGENT_MODE=supervisor", "PALAGENT_TOKEN=new-agent-token", "PALAGENT_ADMIN_PASSWORD=pw12345", "PALAGENT_SERVER_NAME=Palhalla II", "HOME=/tmp"} {
		if !strings.Contains(env, want) {
			t.Errorf("env missing %s: %s", want, env)
		}
	}
}

// A slug whose container already exists is refused before the mkdir and
// the image pull, and with 409 — the status palcon reads as "nothing was
// made", which is what keeps it from registering the server anyway.
func TestProvisionerRefusesNameInUse(t *testing.T) {
	srv, fake, dataRoot := newProvisioner(t)

	resp, m := do(t, srv, "POST", "/v1/provision", testToken, map[string]any{
		"slug": "main", "token": "new-agent-token-0123456789abcdef", "adminPassword": "pw12345",
		"gamePort": 9211, "restPort": 9212, "rconPort": 9575, "agentPort": 9811,
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("provision onto an existing name: %d %v, want 409", resp.StatusCode, m)
	}
	if msg, _ := m["error"].(string); !strings.Contains(msg, "palagent-main") {
		t.Errorf("error should name the container in the way: %v", m)
	}
	joined := strings.Join(fake.calls, " | ")
	if strings.Contains(joined, "/images/create") || strings.Contains(joined, "/containers/create") {
		t.Errorf("pulled or created despite the conflict: %s", joined)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "main")); !os.IsNotExist(err) {
		t.Errorf("data dir created for a refused provision (err %v)", err)
	}
}

func toStrings(in []any) []string {
	out := make([]string, len(in))
	for i, v := range in {
		out[i] = v.(string)
	}
	return out
}

func TestProvisionerHealthDefaultsAndDiscover(t *testing.T) {
	srv, _, dataRoot := newProvisioner(t)

	// Health carries the wizard defaults from the provisioner's config.
	_, health := do(t, srv, "GET", "/v1/health", testToken, nil)
	prov, _ := health["provision"].(map[string]any)
	if prov == nil || prov["dataRoot"] != dataRoot || prov["runAs"] != "568:568" || prov["imageTag"] != "latest" {
		t.Fatalf("health provision block = %v", prov)
	}

	// Discover: the supervisor shows with its ports; the provisioner
	// itself and unrelated containers don't; env never leaks.
	resp, m := do(t, srv, "GET", "/v1/discover", testToken, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("discover: %d %v", resp.StatusCode, m)
	}
	servers := m["servers"].([]any)
	if len(servers) != 1 {
		t.Fatalf("discovered = %v, want exactly the supervisor", servers)
	}
	got := servers[0].(map[string]any)
	if got["name"] != "palagent-main" || got["mode"] != "supervisor" || got["running"] != true ||
		got["gamePort"] != float64(9211) || got["agentPort"] != float64(9811) {
		t.Errorf("candidate = %v", got)
	}
	if strings.Contains(fmt.Sprint(m), "secret-must-not-leak") {
		t.Fatal("discovery leaked container env")
	}
}

// Adoption is the one deliberate secret-return path: the provisioner
// injected these values, so handing them back to the authenticated
// control plane recovers a lost registration. Restricted to palagent
// containers.
func TestProvisionerAdopt(t *testing.T) {
	srv, _, _ := newProvisioner(t)

	resp, m := do(t, srv, "POST", "/v1/adopt", testToken, map[string]string{"container": "palagent-main"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("adopt: %d %v", resp.StatusCode, m)
	}
	if m["token"] != "secret-must-not-leak" || m["adminPassword"] != "recovered-pw" ||
		m["serverName"] != "Main World" || m["mode"] != "supervisor" || m["agentPort"] != float64(9811) {
		t.Errorf("adopt result = %v", m)
	}

	// Not-a-palagent and unknown containers refuse.
	if resp, _ := do(t, srv, "POST", "/v1/adopt", testToken, map[string]string{"container": "nginx"}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("nginx adopt: %d, want 400", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/v1/adopt", testToken, map[string]string{"container": "ghost"}); resp.StatusCode != http.StatusNotFound {
		t.Errorf("ghost adopt: %d, want 404", resp.StatusCode)
	}
	// The provisioner itself is not adoptable.
	if resp, _ := do(t, srv, "POST", "/v1/adopt", testToken, map[string]string{"container": "palprovisioner"}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("provisioner adopt: %d, want 400", resp.StatusCode)
	}
}

// Destroy stops before removing (so the world is flushed), keeps the
// volume, and reports where the data still is.
func TestProvisionerDestroy(t *testing.T) {
	srv, fake, dataRoot := newProvisioner(t)

	resp, m := do(t, srv, "POST", "/v1/destroy", testToken, map[string]string{"container": "palagent-main"})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("destroy: %d %v", resp.StatusCode, m)
	}
	if m["container"] != "palagent-main" || m["dataDir"] != filepath.Join(dataRoot, "main") {
		t.Errorf("destroy result = %v", m)
	}

	joined := strings.Join(fake.calls, " | ")
	stop, remove := strings.Index(joined, "POST /containers/c1/stop"), strings.Index(joined, "DELETE /containers/c1")
	if stop < 0 || remove < 0 {
		t.Fatalf("want a stop then a remove, got: %s", joined)
	}
	if stop > remove {
		t.Errorf("removed before stopping — the world never got flushed: %s", joined)
	}
}

// The label gate, which is the whole security argument for this verb:
// only containers this provisioner created can be destroyed. A palagent
// deployed by hand carries the image but not the label, and is refused —
// including the provisioner itself.
func TestProvisionerDestroyRefusesUnlabelled(t *testing.T) {
	srv, fake, _ := newProvisioner(t)

	for _, name := range []string{"palprovisioner", "nginx"} {
		resp, m := do(t, srv, "POST", "/v1/destroy", testToken, map[string]string{"container": name})
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("destroy %s: %d %v, want 400", name, resp.StatusCode, m)
		}
	}
	if resp, _ := do(t, srv, "POST", "/v1/destroy", testToken, map[string]string{"container": "ghost"}); resp.StatusCode != http.StatusNotFound {
		t.Errorf("destroy ghost: %d, want 404", resp.StatusCode)
	}
	if resp, _ := do(t, srv, "POST", "/v1/destroy", testToken, map[string]string{"container": ""}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("destroy without a name: %d, want 400", resp.StatusCode)
	}

	// Nothing was stopped or removed on any refused path.
	if joined := strings.Join(fake.calls, " | "); strings.Contains(joined, "DELETE /containers") || strings.Contains(joined, "/stop") {
		t.Errorf("a refused destroy still touched docker: %s", joined)
	}
}

func TestNonProvisionerRefusesDestroy(t *testing.T) {
	srv, _ := newTestAgent(t, "exit 0") // companion
	if resp, _ := do(t, srv, "POST", "/v1/destroy", testToken, map[string]string{"container": "x"}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("companion destroy: %d, want 400", resp.StatusCode)
	}
}

func TestProvisionerValidation(t *testing.T) {
	srv, _, _ := newProvisioner(t)
	cases := []map[string]any{
		{"slug": "../evil", "token": "long-enough-token-123456", "adminPassword": "x", "gamePort": 1, "restPort": 2, "rconPort": 3, "agentPort": 4},
		{"slug": "ok", "token": "short", "adminPassword": "x", "gamePort": 1, "restPort": 2, "rconPort": 3, "agentPort": 4},
		{"slug": "ok", "token": "long-enough-token-123456", "adminPassword": "", "gamePort": 1, "restPort": 2, "rconPort": 3, "agentPort": 4},
		{"slug": "ok", "token": "long-enough-token-123456", "adminPassword": "x", "runAs": "steam", "gamePort": 1, "restPort": 2, "rconPort": 3, "agentPort": 4},
		{"slug": "ok", "token": "long-enough-token-123456", "adminPassword": "x", "gamePort": 5, "restPort": 5, "rconPort": 3, "agentPort": 4},
		{"slug": "ok", "token": "long-enough-token-123456", "adminPassword": "x", "imageTag": "beta@sha256:junk", "gamePort": 1, "restPort": 2, "rconPort": 3, "agentPort": 4},
	}
	for i, body := range cases {
		if resp, m := do(t, srv, "POST", "/v1/provision", testToken, body); resp.StatusCode != http.StatusBadRequest {
			t.Errorf("case %d: got %d %v, want 400", i, resp.StatusCode, m)
		}
	}
}

func TestNonProvisionerRefusesProvision(t *testing.T) {
	srv, _ := newTestAgent(t, "exit 0") // companion
	if resp, _ := do(t, srv, "POST", "/v1/provision", testToken, map[string]any{"slug": "x"}); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("companion provision: %d, want 400", resp.StatusCode)
	}
}

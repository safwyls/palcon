package dockerctl_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/safwyls/palcon/internal/dockerctl"
)

// dockerSpy records the requests a client makes and answers with canned
// bodies, so the wire format the daemon actually sees is asserted.
type dockerSpy struct {
	mu       sync.Mutex
	requests []string
	status   int
	body     string
}

func newSpy(t *testing.T, body string) (*dockerSpy, *dockerctl.Client) {
	t.Helper()
	spy := &dockerSpy{status: http.StatusOK, body: body}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		spy.mu.Lock()
		spy.requests = append(spy.requests, r.Method+" "+r.URL.RequestURI())
		status, body := spy.status, spy.body
		spy.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	client, err := dockerctl.New(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return spy, client
}

func (d *dockerSpy) last() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.requests) == 0 {
		return ""
	}
	return d.requests[len(d.requests)-1]
}

func (d *dockerSpy) set(status int, body string) {
	d.mu.Lock()
	d.status, d.body = status, body
	d.mu.Unlock()
}

func TestRestartSendsTheStopGrace(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusNoContent, "")

	if err := client.Restart(context.Background(), "palagent-main"); err != nil {
		t.Fatalf("Restart: %v", err)
	}
	// The grace period is what gives Palworld time to flush its world
	// instead of taking a SIGKILL.
	if got := spy.last(); !strings.Contains(got, "/containers/palagent-main/restart?t=") {
		t.Errorf("restart request = %q", got)
	}
}

func TestContainerRemoveKeepsTheVolume(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusNoContent, "")

	if err := client.ContainerRemove(context.Background(), "cafe"); err != nil {
		t.Fatalf("ContainerRemove: %v", err)
	}
	got := spy.last()
	// v=0 is the promise that a provisioned server's world survives; force=0
	// means the caller's graceful stop isn't undone by a SIGKILL here.
	if !strings.Contains(got, "v=0") || !strings.Contains(got, "force=0") {
		t.Errorf("remove request = %q, want v=0 and force=0", got)
	}
	if !strings.HasPrefix(got, "DELETE ") {
		t.Errorf("remove should be a DELETE: %q", got)
	}
}

// A container that's already gone is the state the caller asked for.
func TestContainerRemoveTreatsMissingAsDone(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusNotFound, `{"message":"no such container"}`)

	if err := client.ContainerRemove(context.Background(), "ghost"); err != nil {
		t.Errorf("removing an already-gone container: %v, want success", err)
	}
}

func TestContainerRemoveReportsARunningContainer(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusConflict, `{"message":"You cannot remove a running container"}`)

	err := client.ContainerRemove(context.Background(), "cafe")
	if err == nil {
		t.Fatal("removing a running container reported success")
	}
	// Docker's own message is more useful than anything invented here.
	if !strings.Contains(err.Error(), "running container") {
		t.Errorf("error lost docker's explanation: %v", err)
	}
}

func TestContainerList(t *testing.T) {
	_, client := newSpy(t, `[
	  {"Id":"c1","Names":["/palagent-main"],"Image":"ghcr.io/safwyls/palagent:latest","State":"running",
	   "Labels":{"palcon.provisioned":"true","palcon.slug":"main"},
	   "Ports":[{"PrivatePort":8211,"PublicPort":9211,"Type":"udp"},
	            {"PrivatePort":8811,"PublicPort":0,"Type":"tcp"}]},
	  {"Id":"c2","Names":[],"Image":"nginx","State":"exited","Labels":null,"Ports":[]}
	]`)

	list, err := client.ContainerList(context.Background())
	if err != nil {
		t.Fatalf("ContainerList: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("containers = %d, want 2", len(list))
	}

	first := list[0]
	// The leading slash docker puts on every name is stripped, so callers
	// can compare against the name they asked for.
	if first.Name != "palagent-main" {
		t.Errorf("Name = %q, want the slash stripped", first.Name)
	}
	if first.Labels["palcon.slug"] != "main" {
		t.Errorf("labels = %v", first.Labels)
	}
	if first.Ports["8211/udp"] != 9211 {
		t.Errorf("published port = %v, want 9211", first.Ports["8211/udp"])
	}
	// An unpublished port has no host side and must not appear as port 0.
	if _, ok := first.Ports["8811/tcp"]; ok {
		t.Errorf("an unpublished port was reported: %v", first.Ports)
	}
	// A container with no names at all must not panic the parser.
	if list[1].Name != "" {
		t.Errorf("nameless container = %q", list[1].Name)
	}
}

func TestContainerListReportsADeadDaemon(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusInternalServerError, `{"message":"boom"}`)

	if _, err := client.ContainerList(context.Background()); err == nil {
		t.Error("a failing daemon reported success")
	}
}

func TestInspectEnv(t *testing.T) {
	_, client := newSpy(t, `{"Config":{"Env":["PALAGENT_MODE=supervisor","PALAGENT_TOKEN=secret"]}}`)

	env, err := client.InspectEnv(context.Background(), "c1")
	if err != nil {
		t.Fatalf("InspectEnv: %v", err)
	}
	if len(env) != 2 || env[0] != "PALAGENT_MODE=supervisor" {
		t.Errorf("env = %v", env)
	}
}

func TestInspectEnvOnAMissingContainer(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusNotFound, `{"message":"no such container"}`)

	if _, err := client.InspectEnv(context.Background(), "ghost"); err == nil {
		t.Error("inspecting a missing container reported success")
	}
}

// A 403 from a socket proxy almost always means a permission it hasn't been
// granted, which is easy to fix and impossible to guess from "forbidden".
func TestProxyPermissionErrorsExplainThemselves(t *testing.T) {
	spy, client := newSpy(t, "")
	spy.set(http.StatusForbidden, "")

	err := client.Restart(context.Background(), "x")
	if err == nil {
		t.Fatal("a 403 reported success")
	}
	if !strings.Contains(err.Error(), "POST=1") {
		t.Errorf("a proxy 403 should name the missing permission: %v", err)
	}
}

package agentctl_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/palagent"
)

// newProvisioner spins a real provisioner-mode palagent over a fake docker
// endpoint, so the client is exercised against the actual server rather
// than a stub of it.
func newProvisioner(t *testing.T) (*agentctl.Client, string) {
	t.Helper()
	docker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/images/create":
			io.WriteString(w, `{"status":"done"}`+"\n")
		case r.URL.Path == "/containers/create":
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{"Id":"cafe"}`)
		case r.URL.Path == "/containers/json":
			w.Header().Set("Content-Type", "application/json")
			// palagent-main is provisioner-made; nginx is a bystander with
			// neither the image nor the label, so it is invisible to
			// discovery and refused by destroy.
			io.WriteString(w, `[{"Id":"cafe","Names":["/palagent-main"],
			  "Image":"ghcr.io/safwyls/palagent:latest","State":"running",
			  "Labels":{"palcon.provisioned":"true","palcon.slug":"main"},
			  "Ports":[{"PrivatePort":8811,"PublicPort":9811,"Type":"tcp"}]},
			 {"Id":"beef","Names":["/nginx"],"Image":"nginx:latest",
			  "State":"running","Labels":{},"Ports":[]}]`)
		case strings.HasSuffix(r.URL.Path, "/json"):
			io.WriteString(w, `{"Config":{"Env":["PALAGENT_MODE=supervisor","PALAGENT_TOKEN=recovered-token","PALAGENT_ADMIN_PASSWORD=recovered-pw","PALAGENT_SERVER_NAME=Main"]}}`)
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(docker.Close)

	dataRoot := t.TempDir()
	agent, err := palagent.New(palagent.Config{
		Token: token, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: docker.URL, DataRoot: dataRoot,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(agent.Handler())
	t.Cleanup(srv.Close)

	client, err := agentctl.New(srv.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	return client, dataRoot
}

func TestBaseURLIsTheConfiguredEndpoint(t *testing.T) {
	client, err := agentctl.New("http://palagent-main:8811/", token)
	if err != nil {
		t.Fatal(err)
	}
	// The trailing slash is trimmed, so path joining can't double it.
	if client.BaseURL() != "http://palagent-main:8811" {
		t.Errorf("BaseURL = %q", client.BaseURL())
	}
}

func TestProvisionDiscoverAdoptDestroy(t *testing.T) {
	client, dataRoot := newProvisioner(t)
	ctx := context.Background()

	res, err := client.Provision(ctx, palagent.ProvisionRequest{
		Slug: "palhalla", ImageTag: "latest",
		Token: "new-agent-token-0123456789abcdef", AdminPassword: "pw12345",
		ServerName: "Palhalla", RunAs: "568:568",
		GamePort: 8211, RESTPort: 8212, RCONPort: 25575, AgentPort: 8811,
	})
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if res.Container != "palagent-palhalla" || res.DataDir != filepath.Join(dataRoot, "palhalla") {
		t.Errorf("provision result = %+v", res)
	}

	found, err := client.Discover(ctx)
	if err != nil {
		t.Fatalf("Discover: %v", err)
	}
	if len(found) != 1 || found[0].Name != "palagent-main" || found[0].AgentPort != 9811 {
		t.Fatalf("discovered = %+v", found)
	}

	adopted, err := client.Adopt(ctx, "palagent-main")
	if err != nil {
		t.Fatalf("Adopt: %v", err)
	}
	if adopted.Token != "recovered-token" || adopted.AdminPassword != "recovered-pw" {
		t.Errorf("adopt did not recover the credentials: %+v", adopted)
	}
	if adopted.ServerName != "Main" || adopted.Mode != "supervisor" {
		t.Errorf("adopt result = %+v", adopted)
	}

	destroyed, err := client.Destroy(ctx, "palagent-main")
	if err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if destroyed.Container != "palagent-main" || destroyed.DataDir != filepath.Join(dataRoot, "main") {
		t.Errorf("destroy result = %+v", destroyed)
	}
}

// A provisioner refusing a request is the caller's problem to report, so it
// arrives as ErrRejected rather than a bare transport error.
func TestProvisionerRefusalsAreRejections(t *testing.T) {
	client, _ := newProvisioner(t)
	ctx := context.Background()

	if _, err := client.Adopt(ctx, ""); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("adopting nothing: %v, want ErrRejected", err)
	}
	// A slug the provisioner won't accept.
	if _, err := client.Provision(ctx, palagent.ProvisionRequest{Slug: "../escape"}); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("provisioning a traversal slug: %v, want ErrRejected", err)
	}
}

// "It isn't there" and "I refuse" need to be separable: a caller destroying
// a container can treat the first as success and carry on, where folding
// both into ErrRejected leaves it unable to tell a finished job from a
// forbidden one — and stuck retrying forever.
func TestMissingIsDistinctFromRefused(t *testing.T) {
	client, _ := newProvisioner(t)
	ctx := context.Background()

	err := errFrom(client.Destroy(ctx, "no-such-container"))
	if !errors.Is(err, agentctl.ErrNotFound) {
		t.Errorf("destroying a missing container: %v, want ErrNotFound", err)
	}
	if errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("a missing container must not also read as a refusal: %v", err)
	}

	// The label gate's refusal stays a refusal — a container that exists
	// but isn't ours must not be mistaken for "already gone" and allowed to
	// proceed to the row delete.
	err = errFrom(client.Destroy(ctx, "nginx"))
	if !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("destroying an unlabelled container: %v, want ErrRejected", err)
	}
	if errors.Is(err, agentctl.ErrNotFound) {
		t.Errorf("a refused destroy must not read as already-gone: %v", err)
	}
}

func errFrom[T any](_ T, err error) error { return err }

// Power and the file verbs are supervisor-mode features. A companion agent
// answers 400, which the client surfaces as a rejection so palcon can fall
// back to the docker proxy instead of reporting an outage.
func TestSupervisorOnlyVerbsAgainstACompanion(t *testing.T) {
	srv := newAgent(t, "exit 0")
	client, err := agentctl.New(srv.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, err := client.Power(ctx, "start", 0); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("Power on a companion: %v, want ErrRejected", err)
	}
	if _, err := client.Power(ctx, "stop", 5*time.Second); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("graceful Power on a companion: %v, want ErrRejected", err)
	}
	if _, err := client.GameLogs(ctx, 50); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("GameLogs on a companion: %v, want ErrRejected", err)
	}
}

// The provisioner verbs are equally mode-gated the other way.
func TestProvisionerVerbsAgainstACompanion(t *testing.T) {
	srv := newAgent(t, "exit 0")
	client, err := agentctl.New(srv.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, err := client.Discover(ctx); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("Discover on a companion: %v, want ErrRejected", err)
	}
	if _, err := client.Destroy(ctx, "x"); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("Destroy on a companion: %v, want ErrRejected", err)
	}
}

// newAgentWithConfig seeds the settings file the game writes on first boot;
// the agent edits it in place rather than creating one, so an install that
// has never run has nothing to serve.
func newAgentWithConfig(t *testing.T, ini string) *agentctl.Client {
	t.Helper()
	install := t.TempDir()
	cfgPath := filepath.Join(install, filepath.FromSlash("Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"))
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte(ini), 0o644); err != nil {
		t.Fatal(err)
	}
	agent, err := palagent.New(palagent.Config{
		Token: token, InstallDir: install, Version: "test",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(agent.Handler())
	t.Cleanup(srv.Close)
	client, err := agentctl.New(srv.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestConfigRoundTrip(t *testing.T) {
	const seed = "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName=\"old\")\n"
	client := newAgentWithConfig(t, seed)
	ctx := context.Background()

	got, err := client.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if string(got) != seed {
		t.Errorf("GetConfig returned %q, want the seeded file", got)
	}

	const updated = "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ServerName=\"new\")\n"
	if err := client.PutConfig(ctx, []byte(updated)); err != nil {
		t.Fatalf("PutConfig: %v", err)
	}
	got, err = client.GetConfig(ctx)
	if err != nil {
		t.Fatalf("GetConfig after a write: %v", err)
	}
	if string(got) != updated {
		t.Errorf("config round-trip mismatch:\n got %q\nwant %q", got, updated)
	}
}

// An install that has never booted has no settings file, which is a
// rejection the UI can explain rather than a transport failure.
func TestGetConfigOnAnUnbootedInstall(t *testing.T) {
	srv := newAgent(t, "exit 0")
	client, err := agentctl.New(srv.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetConfig(context.Background()); !errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("GetConfig with no config file: %v, want ErrRejected", err)
	}
}

// An agent that isn't there at all is a transport failure, not a rejection —
// the distinction is what lets palcon say "unreachable" rather than
// "misconfigured".
func TestUnreachableAgentIsNotARejection(t *testing.T) {
	client, err := agentctl.New("http://127.0.0.1:1", token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Health(context.Background())
	if err == nil {
		t.Fatal("a dead endpoint reported success")
	}
	if errors.Is(err, agentctl.ErrRejected) {
		t.Errorf("an unreachable agent was reported as a rejection: %v", err)
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error should say unreachable: %v", err)
	}
}

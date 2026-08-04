package api_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/palagent"
	"github.com/safwyls/palcon/internal/store"
)

func TestProvisionServer(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	rec := app.do(t, "POST", "/api/servers/provision", map[string]any{
		"name": "Palhalla II", "host": "10.0.0.9", "dataPath": "/mnt/pool/apps/palworld-p2",
		"gamePort": 9211, "restPort": 9212, "rconPort": 9575, "agentPort": 9811,
		"imageTag": "beta",
	}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("provision: %d (body %s)", rec.Code, rec.Body)
	}
	var res struct {
		Server struct {
			ID            int64  `json:"id"`
			Host          string `json:"host"`
			RESTPort      int    `json:"restPort"`
			AgentURL      string `json:"agentUrl"`
			HasAgentToken bool   `json:"hasAgentToken"`
			UseREST       bool   `json:"useRest"`
		} `json:"server"`
		AdminPassword string `json:"adminPassword"`
		AgentToken    string `json:"agentToken"`
		Stack         string `json:"stack"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}

	// The row is fully wired: reachable host/ports, agent URL + token,
	// REST password = the admin password.
	if res.Server.Host != "10.0.0.9" || res.Server.RESTPort != 9212 ||
		res.Server.AgentURL != "http://10.0.0.9:9811" || !res.Server.HasAgentToken || !res.Server.UseREST {
		t.Errorf("server row = %+v", res.Server)
	}
	srv, err := app.store.GetServer(t.Context(), res.Server.ID)
	if err != nil || srv.RESTPassword != res.AdminPassword || srv.AgentToken != res.AgentToken {
		t.Errorf("stored credentials don't match the response (err %v)", err)
	}
	if len(res.AdminPassword) < 16 || len(res.AgentToken) < 32 {
		t.Errorf("weak generated credentials: pw %d chars, token %d", len(res.AdminPassword), len(res.AgentToken))
	}

	// The stack carries everything the agent needs, on the beta channel.
	for _, want := range []string{
		"ghcr.io/safwyls/palagent:beta",
		`user: "568:568"`,
		"HOME: /tmp",
		"PALAGENT_MODE: supervisor",
		"PALAGENT_TOKEN: " + res.AgentToken,
		"PALAGENT_ADMIN_PASSWORD: " + res.AdminPassword,
		`"9211:8211/udp"`, `"9212:8212"`, `"9575:25575"`, `"9811:8811"`,
		"/mnt/pool/apps/palworld-p2:/palworld",
	} {
		if !strings.Contains(res.Stack, want) {
			t.Errorf("stack missing %q:\n%s", want, res.Stack)
		}
	}
}

// One-click: with a provisioner configured, provisioning also deploys.
// The provisioner here is a real provisioner-mode palagent over a fake
// docker API — the full palcon → provisioner → docker chain.
func TestProvisionOneClickDeploy(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	var dockerCalls []string
	dockerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dockerCalls = append(dockerCalls, r.URL.Path)
		switch {
		case r.URL.Path == "/images/create":
			w.Write([]byte(`{"status":"done"}` + "\n"))
		case r.URL.Path == "/containers/create":
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte(`{"Id":"cafe"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(dockerSrv.Close)

	dataRoot := t.TempDir()
	provAgent, err := palagent.New(palagent.Config{
		Token: agentToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: dataRoot,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provSrv := httptest.NewServer(provAgent.Handler())
	t.Cleanup(provSrv.Close)
	app.api.Provisioner, err = agentctl.New(provSrv.URL, agentToken)
	if err != nil {
		t.Fatal(err)
	}

	// No dataPath: the one-click wizard doesn't ask — the provisioner's
	// data root decides, and the reference stack must reflect it.
	rec := app.do(t, "POST", "/api/servers/provision", map[string]any{
		"name": "One Click", "host": "10.0.0.9",
		"serverDesc": "motd here",
	}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("provision: %d (body %s)", rec.Code, rec.Body)
	}
	var res struct {
		Deployed bool   `json:"deployed"`
		DataDir  string `json:"dataDir"`
		Stack    string `json:"stack"`
		Server   struct {
			GamePort      int    `json:"gamePort"`
			ContainerName string `json:"containerName"`
		} `json:"server"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if !res.Deployed || res.DataDir != filepath.Join(dataRoot, "one-click") {
		t.Errorf("result = %+v, want deployed into one-click", res)
	}
	if !strings.Contains(res.Stack, filepath.Join(dataRoot, "one-click")+":/palworld") {
		t.Errorf("stack volume line missing the resolved data dir:\n%s", res.Stack)
	}
	if res.Server.GamePort != 8211 {
		t.Errorf("gamePort = %d, want default 8211", res.Server.GamePort)
	}
	joined := strings.Join(dockerCalls, " ")
	if !strings.Contains(joined, "/containers/create") || !strings.Contains(joined, "/start") {
		t.Errorf("docker never created/started: %v", dockerCalls)
	}
	// The row records the container the provisioner made — without it the
	// destroy path has no name to pass back, and the logs viewer and
	// watchdog stay dark for the one server palcon knows the name of.
	if res.Server.ContainerName != "palagent-one-click" {
		t.Errorf("containerName = %q, want palagent-one-click", res.Server.ContainerName)
	}
}

// Deleting a server destroys its container only when asked, and only
// through the provisioner that created it. The data directory survives
// and is reported back, since removing a container is not consent to
// delete a world.
func TestDeleteServerDestroysContainerWhenAsked(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	var dockerCalls []string
	dockerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dockerCalls = append(dockerCalls, r.Method+" "+r.URL.Path)
		if r.URL.Path == "/containers/json" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[{"Id":"cafe","Names":["/palagent-doomed"],"Image":"ghcr.io/safwyls/palagent:latest",
			  "State":"running","Labels":{"palcon.provisioned":"true","palcon.slug":"doomed"},"Ports":[]}]`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(dockerSrv.Close)

	dataRoot := t.TempDir()
	provAgent, err := palagent.New(palagent.Config{
		Token: agentToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: dataRoot,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provSrv := httptest.NewServer(provAgent.Handler())
	t.Cleanup(provSrv.Close)
	if app.api.Provisioner, err = agentctl.New(provSrv.URL, agentToken); err != nil {
		t.Fatal(err)
	}

	newServer := func(t *testing.T, container string) string {
		t.Helper()
		rec := app.do(t, "POST", "/api/servers", map[string]any{
			"name": "Doomed", "host": "10.0.0.9", "rconPort": 25575, "restPort": 8212,
			"useRest": true, "enabled": true, "containerName": container,
		}, admin)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create server: %d (body %s)", rec.Code, rec.Body)
		}
		var created struct {
			ID int64 `json:"id"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
			t.Fatal(err)
		}
		return itoa(created.ID)
	}

	// Without the flag nothing on the host is touched — the long-standing
	// promise that removing a server only removes the row.
	id := newServer(t, "palagent-doomed")
	if rec := app.do(t, "DELETE", "/api/servers/"+id, nil, admin); rec.Code != http.StatusNoContent {
		t.Fatalf("plain delete: %d (body %s)", rec.Code, rec.Body)
	}
	if len(dockerCalls) != 0 {
		t.Errorf("a plain delete reached docker: %v", dockerCalls)
	}

	// With it, the container is stopped and removed, and the world's
	// directory comes back so the operator knows what survived.
	id = newServer(t, "palagent-doomed")
	rec := app.do(t, "DELETE", "/api/servers/"+id+"?removeContainer=true", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("destroying delete: %d (body %s)", rec.Code, rec.Body)
	}
	var res struct {
		Destroyed string `json:"destroyed"`
		DataDir   string `json:"dataDir"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Destroyed != "palagent-doomed" || res.DataDir != filepath.Join(dataRoot, "doomed") {
		t.Errorf("result = %+v", res)
	}
	if joined := strings.Join(dockerCalls, " | "); !strings.Contains(joined, "DELETE /containers/cafe") {
		t.Errorf("container never removed: %s", joined)
	}
	if rec := app.do(t, "GET", "/api/servers/"+id, nil, admin); rec.Code != http.StatusNotFound {
		t.Errorf("row survived the destroy: %d", rec.Code)
	}
}

// A destroy the provisioner refuses must leave the row alone: the
// operator still needs the card (and its credentials) to deal with the
// container by hand.
func TestDeleteServerKeepsRowWhenDestroyRefused(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	// A palagent container with no palcon.provisioned label — deployed by
	// hand, so the provisioner won't unmake it.
	dockerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/containers/json" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`[{"Id":"c1","Names":["/palagent-byhand"],"Image":"ghcr.io/safwyls/palagent:latest",
			  "State":"running","Labels":{},"Ports":[]}]`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(dockerSrv.Close)

	provAgent, err := palagent.New(palagent.Config{
		Token: agentToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: t.TempDir(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provSrv := httptest.NewServer(provAgent.Handler())
	t.Cleanup(provSrv.Close)
	if app.api.Provisioner, err = agentctl.New(provSrv.URL, agentToken); err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "POST", "/api/servers", map[string]any{
		"name": "By Hand", "host": "10.0.0.9", "rconPort": 25575, "restPort": 8212,
		"useRest": true, "enabled": true, "containerName": "palagent-byhand",
	}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create server: %d (body %s)", rec.Code, rec.Body)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	id := itoa(created.ID)

	if rec := app.do(t, "DELETE", "/api/servers/"+id+"?removeContainer=true", nil, admin); rec.Code != http.StatusBadRequest {
		t.Fatalf("refused destroy: %d (body %s), want 400", rec.Code, rec.Body)
	}
	if rec := app.do(t, "GET", "/api/servers/"+id, nil, admin); rec.Code != http.StatusOK {
		t.Errorf("row deleted despite the refused destroy: %d", rec.Code)
	}
}

// Asking to destroy with no provisioner configured is refused before the
// row goes, rather than silently degrading to a plain delete.
func TestDeleteServerRefusesDestroyWithoutProvisioner(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	id := itoa(createTestServer(t, app))

	if rec := app.do(t, "DELETE", "/api/servers/"+id+"?removeContainer=true", nil, admin); rec.Code != http.StatusBadRequest {
		t.Fatalf("destroy without a provisioner: %d (body %s), want 400", rec.Code, rec.Body)
	}
	if rec := app.do(t, "GET", "/api/servers/"+id, nil, admin); rec.Code != http.StatusOK {
		t.Errorf("row deleted anyway: %d", rec.Code)
	}
}

// A name whose container already exists on the host must be refused
// outright. The regression this guards: the deploy failed, but the row had
// already been written, leaving a server registered with credentials the
// running container has never seen — visible in the rail, unreachable
// forever.
func TestProvisionNameConflictRegistersNothing(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	created := false
	dockerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			w.Write([]byte(`[{"Id":"c1","Names":["/palagent-taken"],"Image":"ghcr.io/safwyls/palagent:latest","State":"running",
			  "Ports":[{"PrivatePort":8811,"PublicPort":8811,"Type":"tcp"}]}]`))
		case "/containers/c1/json":
			w.Write([]byte(`{"Config":{"Env":["PALAGENT_MODE=supervisor"]}}`))
		case "/images/create":
			w.Write([]byte(`{"status":"done"}` + "\n"))
		case "/containers/create":
			created = true
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"message":"Conflict. The container name \"/palagent-taken\" is already in use"}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(dockerSrv.Close)

	provAgent, err := palagent.New(palagent.Config{
		Token: agentToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: t.TempDir(),
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provSrv := httptest.NewServer(provAgent.Handler())
	t.Cleanup(provSrv.Close)
	if app.api.Provisioner, err = agentctl.New(provSrv.URL, agentToken); err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "POST", "/api/servers/provision", map[string]any{
		"name": "Taken", "host": "10.0.0.9",
	}, admin)
	if rec.Code != http.StatusConflict {
		t.Fatalf("provision onto a taken name: %d, want 409 (body %s)", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "palagent-taken") {
		t.Errorf("error should name the container that's in the way: %s", rec.Body)
	}
	if created {
		t.Error("docker create was attempted despite the name being visibly taken")
	}
	servers, err := app.store.ListServers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 0 {
		t.Errorf("a refused provision registered %d server(s): %+v", len(servers), servers)
	}
}

// An unreachable provisioner is the other half of the same decision: there
// is nothing to conflict with, the generated stack is still deployable by
// hand, so the row stays and the wizard falls back to pasting.
func TestProvisionKeepsRowWhenProvisionerUnreachable(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close() // nothing listens: every call fails at the transport
	prov, err := agentctl.New(dead.URL, agentToken)
	if err != nil {
		t.Fatal(err)
	}
	app.api.Provisioner = prov

	rec := app.do(t, "POST", "/api/servers/provision", map[string]any{
		"name": "Fallback", "host": "10.0.0.9", "dataPath": "/mnt/pool/apps/fallback",
	}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("provision: %d, want 201 (body %s)", rec.Code, rec.Body)
	}
	var res struct {
		Deployed    bool   `json:"deployed"`
		DeployError string `json:"deployError"`
		Stack       string `json:"stack"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Deployed || res.DeployError == "" || res.Stack == "" {
		t.Errorf("want an undeployed row with a paste fallback, got %+v", res)
	}
	servers, err := app.store.ListServers(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(servers) != 1 {
		t.Errorf("registered %d servers, want the one waiting for a manual deploy", len(servers))
	}
}

func TestProvisionDefaultsAndDiscover(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)

	dockerSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/containers/json":
			w.Write([]byte(`[
			  {"Id":"c1","Names":["/palagent-adopted"],"Image":"ghcr.io/safwyls/palagent:beta","State":"running",
			   "Ports":[{"PrivatePort":8811,"PublicPort":9811,"Type":"tcp"},{"PrivatePort":8212,"PublicPort":9212,"Type":"tcp"}]},
			  {"Id":"c2","Names":["/palagent-orphan"],"Image":"ghcr.io/safwyls/palagent:beta","State":"exited",
			   "Ports":[{"PrivatePort":8811,"PublicPort":9911,"Type":"tcp"}]}
			]`))
		case r.URL.Path == "/containers/c1/json", r.URL.Path == "/containers/c2/json":
			w.Write([]byte(`{"Config":{"Env":["PALAGENT_MODE=supervisor","PALAGENT_TOKEN=adopted-token-0123456789abcdef","PALAGENT_ADMIN_PASSWORD=adopted-pw","PALAGENT_SERVER_NAME=Orphaned World"]}}`))
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(dockerSrv.Close)

	provAgent, err := palagent.New(palagent.Config{
		Token: agentToken, InstallDir: t.TempDir(), Version: "test",
		Mode: "provisioner", DockerHost: dockerSrv.URL, DataRoot: t.TempDir(),
		PublicHost: "10.99.0.5",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	provSrv := httptest.NewServer(provAgent.Handler())
	t.Cleanup(provSrv.Close)
	app.api.Provisioner, err = agentctl.New(provSrv.URL, agentToken)
	if err != nil {
		t.Fatal(err)
	}

	// An existing row holding the default port set (and the "adopted"
	// candidate's agent port) forces the proposal to a free offset and
	// marks the candidate registered.
	if _, err := app.store.CreateServer(t.Context(), &store.Server{
		Name: "existing", Host: "10.99.0.5", RCONPort: 25575, RESTPort: 8212, GamePort: 8211,
		UseREST: true, Enabled: true, AgentURL: "http://10.99.0.5:9811", AgentToken: agentToken,
	}); err != nil {
		t.Fatal(err)
	}

	rec := app.do(t, "GET", "/api/servers/provision/defaults", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("defaults: %d (body %s)", rec.Code, rec.Body)
	}
	var defs struct {
		Available bool           `json:"available"`
		Host      string         `json:"host"`
		RunAs     string         `json:"runAs"`
		Ports     map[string]int `json:"ports"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &defs); err != nil {
		t.Fatal(err)
	}
	if !defs.Available || defs.Host != "10.99.0.5" || defs.RunAs != "568:568" {
		t.Errorf("defaults = %+v, want declared host + run-as", defs)
	}
	// Rows AND containers hold ports — the ghost container on 9911 has no
	// row, and the proposal must still avoid it.
	used := map[int]bool{8211: true, 8212: true, 25575: true, 9811: true, 9212: true, 9911: true}
	for _, p := range defs.Ports {
		if used[p] {
			t.Errorf("proposed ports collide with tracked/container ones: %v", defs.Ports)
		}
	}

	rec = app.do(t, "GET", "/api/servers/provision/discover", nil, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("discover: %d (body %s)", rec.Code, rec.Body)
	}
	var disc struct {
		Servers []struct {
			Name       string `json:"name"`
			Registered bool   `json:"registered"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &disc); err != nil {
		t.Fatal(err)
	}
	byName := map[string]bool{}
	for _, s := range disc.Servers {
		byName[s.Name] = s.Registered
	}
	if !byName["palagent-adopted"] || byName["palagent-orphan"] {
		t.Errorf("registered flags wrong: %v", disc.Servers)
	}

	// Adopt the orphan: one call recreates a fully wired row with the
	// container's own secrets and the declared host.
	rec = app.do(t, "POST", "/api/servers/adopt", map[string]string{"container": "palagent-orphan"}, admin)
	if rec.Code != http.StatusCreated {
		t.Fatalf("adopt: %d (body %s)", rec.Code, rec.Body)
	}
	var adopted struct {
		Server struct {
			ID       int64  `json:"id"`
			Name     string `json:"name"`
			Host     string `json:"host"`
			AgentURL string `json:"agentUrl"`
		} `json:"server"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &adopted); err != nil {
		t.Fatal(err)
	}
	if adopted.Server.Name != "Orphaned World" || adopted.Server.Host != "10.99.0.5" ||
		adopted.Server.AgentURL != "http://10.99.0.5:9911" {
		t.Errorf("adopted row = %+v", adopted.Server)
	}
	row, err := app.store.GetServer(t.Context(), adopted.Server.ID)
	if err != nil || row.AgentToken != "adopted-token-0123456789abcdef" || row.RESTPassword != "adopted-pw" {
		t.Errorf("adopted credentials wrong (err %v)", err)
	}
}

func TestProvisionValidation(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	cases := []map[string]any{
		{"host": "h", "dataPath": "/x"},                                             // no name
		{"name": "n", "dataPath": "/x"},                                             // no host
		{"name": "n", "host": "h"},                                                 // no data path, no provisioner
		{"name": "n", "host": "h", "dataPath": "relative/path"},                     // non-absolute path
		{"name": "n", "host": "h", "dataPath": "/x", "gamePort": 80, "restPort": 80},          // duplicate ports
		{"name": "n", "host": "h", "dataPath": "/x", "imageTag": "beta\n    evil: true"},      // yaml injection via tag
		{"name": "n", "host": "h", "dataPath": "/x", "imageTag": "beta beta"},                 // not a docker tag
	}
	for i, body := range cases {
		if rec := app.do(t, "POST", "/api/servers/provision", body, admin); rec.Code != http.StatusBadRequest {
			t.Errorf("case %d: got %d, want 400 (body %s)", i, rec.Code, rec.Body)
		}
	}
}

func TestProvisionAdminOnly(t *testing.T) {
	app, admin := newTestAppWithAdmin(t)
	app.createUser(t, admin, "operator", "operatorpassword1", "user", []string{store.PermPower})
	operator := app.login(t, "operator", "operatorpassword1")
	if rec := app.do(t, "POST", "/api/servers/provision", map[string]any{
		"name": "n", "host": "h", "dataPath": "/x",
	}, operator); rec.Code != http.StatusForbidden {
		t.Errorf("non-admin provision: got %d, want 403", rec.Code)
	}
}

package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/safwyls/palcon/internal/agentctl"
	"github.com/safwyls/palcon/internal/palagent"
	"github.com/safwyls/palcon/internal/store"
)

// Provisioning ("new server from the dashboard", docs/sidecar-agent.md
// phase 4): palcon deliberately holds no docker create rights, so this
// endpoint does everything short of the paste — it registers a fully
// wired server row (host, ports, REST/RCON password, agent URL + token)
// and generates the matching supervisor-mode stack file. The human
// deploys the stack; the agent installs the game on first boot and the
// server comes up already manageable (PALAGENT_ADMIN_PASSWORD enforces
// the REST/RCON interfaces on).

type provisionRequest struct {
	Name string `json:"name"`
	// Host is where the stack will run — an address palcon can reach the
	// published ports on.
	Host string `json:"host"`
	// DataPath is the host directory mounted as the install volume.
	DataPath string `json:"dataPath"`
	// Published host ports; the in-container ports stay at the game's
	// defaults (8211/8212/25575) and the agent's 8811.
	GamePort  int `json:"gamePort"`
	RESTPort  int `json:"restPort"`
	RCONPort  int `json:"rconPort"`
	AgentPort int `json:"agentPort"`
	// ImageTag selects the palagent channel; default latest.
	ImageTag string `json:"imageTag"`
	// AdminPassword is generated when blank.
	AdminPassword string `json:"adminPassword"`
	// ServerName/ServerDesc become the in-game ServerName and
	// ServerDescription (MOTD), seeded once on first boot — later edits in
	// the settings editor stick. Name defaults to the palcon display name.
	ServerName string `json:"serverName"`
	ServerDesc string `json:"serverDesc"`
	// RunAs is the container user:group; defaults to the TrueNAS apps
	// user 568:568. Empty string is normalized to the default; "root"
	// omits the user line entirely.
	RunAs string `json:"runAs"`
}

var runAsPattern = regexp.MustCompile(`^\d{1,7}:\d{1,7}$`)

// imageTagPattern is docker's tag grammar; anything looser could inject
// lines into the generated stack yaml.
var imageTagPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) handleProvisionServer(w http.ResponseWriter, r *http.Request) {
	var req provisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Host = strings.TrimSpace(req.Host)
	req.DataPath = strings.TrimSpace(req.DataPath)
	switch {
	case req.Name == "":
		writeError(w, http.StatusBadRequest, "name is required")
		return
	case req.Host == "":
		writeError(w, http.StatusBadRequest, "host is required — the address palcon will reach the server on")
		return
	// With a provisioner configured the data path is its call (<data
	// root>/<slug>) and the wizard doesn't even ask; a paste-flow deploy
	// has no provisioner to decide, so the operator must say.
	case req.DataPath == "" && s.Provisioner == nil:
		writeError(w, http.StatusBadRequest, "data path must be an absolute host path for the install volume")
		return
	case req.DataPath != "" && !filepath.IsAbs(req.DataPath):
		writeError(w, http.StatusBadRequest, "data path must be an absolute host path for the install volume")
		return
	}
	slug := slugify(req.Name)
	if req.DataPath == "" {
		health, err := s.Provisioner.Health(r.Context())
		if err != nil || health.Provision == nil || health.Provision.DataRoot == "" {
			writeError(w, http.StatusBadGateway,
				"the provisioner is unreachable — enter a data path to generate a stack for manual deploy instead")
			return
		}
		req.DataPath = filepath.Join(health.Provision.DataRoot, slug)
	}
	if req.GamePort == 0 {
		req.GamePort = 8211
	}
	if req.RESTPort == 0 {
		req.RESTPort = 8212
	}
	if req.RCONPort == 0 {
		req.RCONPort = 25575
	}
	if req.AgentPort == 0 {
		req.AgentPort = 8811
	}
	seen := map[int]bool{}
	for _, p := range []int{req.GamePort, req.RESTPort, req.RCONPort, req.AgentPort} {
		if p < 1 || p > 65535 || seen[p] {
			writeError(w, http.StatusBadRequest, "ports must be distinct and in 1-65535")
			return
		}
		seen[p] = true
	}
	if req.ImageTag == "" {
		req.ImageTag = "latest"
	}
	if !imageTagPattern.MatchString(req.ImageTag) {
		writeError(w, http.StatusBadRequest, "image tag must match docker tag grammar")
		return
	}
	if req.AdminPassword == "" {
		req.AdminPassword = randomHex(10)
	}
	if req.ServerName == "" {
		req.ServerName = req.Name
	}
	switch {
	case req.RunAs == "":
		req.RunAs = "568:568"
	case req.RunAs == "root":
		req.RunAs = ""
	case !runAsPattern.MatchString(req.RunAs):
		writeError(w, http.StatusBadRequest, `run-as must be numeric uid:gid (or "root")`)
		return
	}
	token := randomHex(24)

	// The container is named from the slug, so a name already on the host
	// can never deploy. Catch it before anything is written: the row would
	// carry freshly generated credentials that the running container has
	// never seen, leaving a server palcon can see and never reach. (The
	// provisioner refuses this itself — checked here too so an older
	// provisioner image, which only fails at docker create, is covered.)
	if s.Provisioner != nil {
		if found, err := s.Provisioner.Discover(r.Context()); err == nil {
			for _, f := range found {
				if f.Name == "palagent-"+slug {
					writeError(w, http.StatusConflict, conflictMessage(slug))
					return
				}
			}
		}
	}

	userLine := ""
	if req.RunAs != "" {
		userLine = fmt.Sprintf(`    # The data path must be owned (or writable) by this user.
    user: "%s"
`, req.RunAs)
	}
	identityEnv := fmt.Sprintf("      PALAGENT_SERVER_NAME: %q\n", req.ServerName)
	if req.ServerDesc != "" {
		identityEnv += fmt.Sprintf("      PALAGENT_SERVER_DESC: %q\n", req.ServerDesc)
	}

	stack := fmt.Sprintf(`# %s — Palworld server supervised by palagent, generated by palcon.
# Deploy as its own stack (TrueNAS custom app / docker compose). On first
# boot the agent installs the game via SteamCMD — watch progress from the
# server's dashboard card — and starts it already wired for REST/RCON.
services:
  palagent:
    image: ghcr.io/safwyls/palagent:%s
%s    environment:
      # SteamCMD needs a writable home; the run-as user has none in the image.
      HOME: /tmp
      PALAGENT_MODE: supervisor
      PALAGENT_TOKEN: %s
      PALAGENT_ADMIN_PASSWORD: %s
%s    ports:
      - "%d:8211/udp"   # game
      - "%d:8212"       # REST (dashboard)
      - "%d:25575"      # RCON (dashboard fallback)
      - "%d:8811"       # palagent API
    volumes:
      - %s:/palworld
    restart: unless-stopped
`, req.Name, req.ImageTag, userLine, token, req.AdminPassword, identityEnv,
		req.GamePort, req.RESTPort, req.RCONPort, req.AgentPort, req.DataPath)

	// One-click (phase 5): when a provisioner is configured, deploy the
	// stack now — before registering, so a deploy that never made anything
	// leaves no server row behind. A *refusal* is fatal: the container name
	// is taken, or the token was rejected, and neither is fixed by pasting
	// the same stack somewhere. Everything else is not — a provisioner that
	// couldn't be reached, or one that created the container and failed to
	// start it, both leave a row and a stack that still describe the server
	// the operator wanted, which is the point of still generating one.
	deployed := false
	deployError := ""
	dataDir := ""
	container := ""
	if s.Provisioner != nil {
		result, err := s.Provisioner.Provision(r.Context(), palagent.ProvisionRequest{
			Slug:          slug,
			ImageTag:      req.ImageTag,
			Token:         token,
			AdminPassword: req.AdminPassword,
			ServerName:    req.ServerName,
			ServerDesc:    req.ServerDesc,
			RunAs:         req.RunAs,
			GamePort:      req.GamePort,
			RESTPort:      req.RESTPort,
			RCONPort:      req.RCONPort,
			AgentPort:     req.AgentPort,
		})
		switch {
		case err == nil:
			deployed = true
			dataDir = result.DataDir
			container = result.Container
		// The only conflict /v1/provision reports is the container name.
		case errors.Is(err, agentctl.ErrBusy):
			s.logger.Warn("provisioner refused deploy: name in use", "server", req.Name, "slug", slug)
			writeError(w, http.StatusConflict, conflictMessage(slug))
			return
		case errors.Is(err, agentctl.ErrRejected):
			s.logger.Warn("provisioner refused deploy", "server", req.Name, "error", err)
			writeAgentError(w, err)
			return
		default:
			deployError = err.Error()
			s.logger.Error("provisioner deploy failed", "server", req.Name, "error", err)
		}
	}

	srv := &store.Server{
		Name: req.Name, Host: req.Host,
		RCONPort: req.RCONPort, RCONPassword: req.AdminPassword,
		RESTPort: req.RESTPort, RESTPassword: req.AdminPassword,
		GamePort: req.GamePort,
		UseREST:  true, Enabled: true,
		AgentURL:   fmt.Sprintf("http://%s:%d", req.Host, req.AgentPort),
		AgentToken: token,
		// Recorded only when the provisioner actually made it: this is the
		// name the destroy path passes back, and — when palcon's own docker
		// proxy happens to watch the same daemon — what the container logs
		// viewer and watchdog key off. Power control is unaffected either
		// way, since every power site tries agentSupervisor before docker.
		ContainerName: container,
	}
	id, err := s.store.CreateServer(r.Context(), srv)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create server")
		return
	}
	srv.ID = id
	s.audit(r, id, "server-provision", srv.Name)
	if deployed {
		s.audit(r, id, "server-deploy", container)
		s.logger.Info("provisioner deployed server", "server", srv.Name, "container", container)
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"server":        toDTO(srv),
		"adminPassword": req.AdminPassword,
		"agentToken":    token,
		"stack":         stack,
		"deployed":      deployed,
		"deployError":   deployError,
		"dataDir":       dataDir,
	})
}

// conflictMessage names both ways out of a taken container name, because
// which one is right depends on what the operator meant: a genuinely new
// server needs a different name, while "I deleted the row and want it
// back" is what adoption is for.
func conflictMessage(slug string) string {
	return fmt.Sprintf("a container named palagent-%s already exists on the host — "+
		"pick a different name, or adopt the existing container from Add server", slug)
}

// handleProvisionDefaults reports everything the wizard can prefill: the
// provisioner's own configuration (data root, public host, run-as, image
// tag) plus a free-port proposal computed from the servers palcon already
// manages. The proposal is a suggestion — something else on the box can
// still hold a port, in which case the deploy fails cleanly at create
// time.
func (s *Server) handleProvisionDefaults(w http.ResponseWriter, r *http.Request) {
	if s.Provisioner == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	health, err := s.Provisioner.Health(r.Context())
	if err != nil || health.Provision == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false})
		return
	}
	servers, err := s.store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list servers")
		return
	}

	// Containers hold ports too — including ones whose palcon row was
	// deleted. The provisioner sees them; a proposal that ignored them
	// would suggest ports that fail at deploy time.
	var containerPorts []int
	if found, err := s.Provisioner.Discover(r.Context()); err == nil {
		for _, f := range found {
			containerPorts = append(containerPorts, f.GamePort, f.RESTPort, f.RCONPort, f.AgentPort)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"available": true,
		"host":      s.inferHost(health.Provision.PublicHost, servers),
		"dataRoot":  health.Provision.DataRoot,
		"runAs":     health.Provision.RunAs,
		"imageTag":  health.Provision.ImageTag,
		"ports":     proposePorts(servers, containerPorts),
	})
}

// inferHost picks the address for new servers: the provisioner's declared
// public host wins; else the host part of the provisioner URL when it's a
// real address (a bare compose service name — no dots, not an IP — can't
// be reached by players or by palcon's REST client); else the address the
// existing servers already use.
func (s *Server) inferHost(declared string, servers []*store.Server) string {
	if declared != "" {
		return declared
	}
	if u, err := url.Parse(s.Provisioner.BaseURL()); err == nil {
		if h := u.Hostname(); strings.Contains(h, ".") {
			return h
		}
	}
	counts := map[string]int{}
	best := ""
	for _, srv := range servers {
		if srv.Host == "" {
			continue
		}
		counts[srv.Host]++
		if best == "" || counts[srv.Host] > counts[best] {
			best = srv.Host
		}
	}
	return best
}

// proposePorts finds the first offset where none of the four default
// ports collide with any port palcon tracks or the host's containers
// hold.
func proposePorts(servers []*store.Server, containerPorts []int) map[string]int {
	used := map[int]bool{}
	for _, srv := range servers {
		used[srv.GamePort] = true
		used[srv.RESTPort] = true
		used[srv.RCONPort] = true
		if u, err := url.Parse(srv.AgentURL); err == nil {
			if p, err := strconv.Atoi(u.Port()); err == nil {
				used[p] = true
			}
		}
	}
	for _, p := range containerPorts {
		if p != 0 {
			used[p] = true
		}
	}
	for offset := 0; offset < 1000; offset++ {
		game, rest, rcon, agent := 8211+offset, 8212+offset, 25575+offset, 8811+offset
		if !used[game] && !used[rest] && !used[rcon] && !used[agent] && game != rest {
			return map[string]int{"game": game, "rest": rest, "rcon": rcon, "agent": agent}
		}
	}
	return map[string]int{"game": 8211, "rest": 8212, "rcon": 25575, "agent": 8811}
}

// handleProvisionDiscover surfaces Palworld-shaped containers already on
// the provisioner's host, marking the ones palcon knows about so the add
// dialog offers only genuine adoptees prominently.
func (s *Server) handleProvisionDiscover(w http.ResponseWriter, r *http.Request) {
	if s.Provisioner == nil {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "servers": []any{}})
		return
	}
	found, err := s.Provisioner.Discover(r.Context())
	if err != nil {
		writeAgentError(w, err)
		return
	}
	servers, err := s.store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list servers")
		return
	}
	registeredAgentPorts := map[int]bool{}
	for _, srv := range servers {
		if u, err := url.Parse(srv.AgentURL); err == nil {
			if p, err := strconv.Atoi(u.Port()); err == nil {
				registeredAgentPorts[p] = true
			}
		}
	}
	type candidate struct {
		agentctl.DiscoveredServer
		Registered bool `json:"registered"`
	}
	out := make([]candidate, 0, len(found))
	for _, f := range found {
		out = append(out, candidate{f, f.AgentPort != 0 && registeredAgentPorts[f.AgentPort]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": true, "servers": out})
}

// handleAdoptServer re-registers a discovered palagent container as a
// server row — the recovery path for "the row was deleted but the
// container lives on". The provisioner returns the container's own
// registration data (secrets included, since it injected them), so
// nothing has to be dug out of the host by hand.
func (s *Server) handleAdoptServer(w http.ResponseWriter, r *http.Request) {
	if s.Provisioner == nil {
		writeError(w, http.StatusBadRequest, "no provisioner configured")
		return
	}
	var req struct {
		Container string `json:"container"`
		// Host optionally overrides the inferred address.
		Host string `json:"host"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Container) == "" {
		writeError(w, http.StatusBadRequest, "container name is required")
		return
	}

	adopted, err := s.Provisioner.Adopt(r.Context(), strings.TrimSpace(req.Container))
	if err != nil {
		writeAgentError(w, err)
		return
	}
	if adopted.Token == "" || adopted.AgentPort == 0 {
		writeError(w, http.StatusBadRequest, "that container has no agent token or published agent port — add it manually")
		return
	}

	servers, err := s.store.ListServers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list servers")
		return
	}
	host := strings.TrimSpace(req.Host)
	if host == "" {
		health, err := s.Provisioner.Health(r.Context())
		declared := ""
		if err == nil && health.Provision != nil {
			declared = health.Provision.PublicHost
		}
		host = s.inferHost(declared, servers)
	}
	if host == "" {
		writeError(w, http.StatusBadRequest,
			"could not infer the host address — set PALAGENT_PUBLIC_HOST on the provisioner or pass one")
		return
	}

	name := adopted.ServerName
	if name == "" {
		name = strings.ReplaceAll(strings.TrimPrefix(adopted.Name, "palagent-"), "-", " ")
	}
	srv := &store.Server{
		Name: name, Host: host,
		RCONPort: adopted.RCONPort, RCONPassword: adopted.AdminPassword,
		RESTPort: adopted.RESTPort, RESTPassword: adopted.AdminPassword,
		GamePort: adopted.GamePort,
		UseREST:  true, Enabled: true,
		AgentURL:      fmt.Sprintf("http://%s:%d", host, adopted.AgentPort),
		AgentToken:    adopted.Token,
		ContainerName: adopted.Name,
	}
	id, err := s.store.CreateServer(r.Context(), srv)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create server")
		return
	}
	srv.ID = id
	s.audit(r, id, "server-adopt", adopted.Name)
	s.logger.Info("adopted server", "container", adopted.Name, "server", name)
	writeJSON(w, http.StatusCreated, map[string]any{"server": toDTO(srv)})
}

// slugify reduces a display name to a container/directory-safe slug.
func slugify(name string) string {
	slug := strings.ToLower(name)
	slug = regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if slug == "" {
		slug = "palworld"
	}
	if len(slug) > 40 {
		slug = slug[:40]
	}
	return strings.Trim(slug, "-")
}

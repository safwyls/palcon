package palagent

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/safwyls/palcon/internal/dockerctl"
)

// Provisioner mode (docs/sidecar-agent.md phase 5): the one component in
// the system allowed to hold docker create rights, exposing exactly one
// verb — instantiate the locked Palworld supervisor template. The
// template lives here in code: a compromised palcon (or leaked
// provisioner token) can stamp out more Palworld servers under the
// configured data root, and nothing else — no arbitrary images, mounts,
// or privileges are expressible through this API.

var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)
var provRunAsPattern = regexp.MustCompile(`^\d{1,7}:\d{1,7}$`)

// tagPattern is docker's tag grammar. The image repository is hardcoded,
// so a hostile tag can't leave this repo's images regardless — but the
// code in front of a root socket accepts no loose input on principle.
var tagPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

// ProvisionRequest instantiates the template. Every field is data for
// the fixed template — none of it changes what kind of container is made.
type ProvisionRequest struct {
	// Slug names the container (palagent-<slug>) and the data directory
	// (<data root>/<slug>).
	Slug string `json:"slug"`
	// ImageTag selects the palagent channel for the new server.
	ImageTag string `json:"imageTag"`
	// Token is the new agent's bearer token (palcon generated it).
	Token string `json:"token"`
	// AdminPassword wires the game's REST/RCON (PALAGENT_ADMIN_PASSWORD).
	AdminPassword string `json:"adminPassword"`
	ServerName    string `json:"serverName"`
	ServerDesc    string `json:"serverDesc"`
	// RunAs is uid:gid for the container ("" = image default/root).
	RunAs string `json:"runAs"`
	// Published host ports.
	GamePort  int `json:"gamePort"`
	RESTPort  int `json:"restPort"`
	RCONPort  int `json:"rconPort"`
	AgentPort int `json:"agentPort"`
}

func (a *Agent) handleProvision(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != "provisioner" {
		writeError(w, http.StatusBadRequest, "agent is not a provisioner")
		return
	}
	var req ProvisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	switch {
	case !slugPattern.MatchString(req.Slug):
		writeError(w, http.StatusBadRequest, "slug must be lowercase letters, digits and dashes")
		return
	case len(req.Token) < minTokenLen:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("token must be at least %d characters", minTokenLen))
		return
	case req.AdminPassword == "":
		writeError(w, http.StatusBadRequest, "admin password is required")
		return
	case req.RunAs != "" && !provRunAsPattern.MatchString(req.RunAs):
		writeError(w, http.StatusBadRequest, "runAs must be numeric uid:gid")
		return
	}
	if req.ImageTag == "" {
		req.ImageTag = "latest"
	}
	if !tagPattern.MatchString(req.ImageTag) {
		writeError(w, http.StatusBadRequest, "image tag must match docker tag grammar")
		return
	}
	seen := map[int]bool{}
	for _, p := range []int{req.GamePort, req.RESTPort, req.RCONPort, req.AgentPort} {
		if p < 1 || p > 65535 || seen[p] {
			writeError(w, http.StatusBadRequest, "ports must be distinct and in 1-65535")
			return
		}
		seen[p] = true
	}

	name := "palagent-" + req.Slug
	// A name already in use can only fail at create — after the mkdir, the
	// chown and a multi-hundred-MB image pull have all reported progress.
	// Check it first, and refuse in the one status the caller can read as
	// "the provisioner made nothing" rather than "something went wrong
	// partway through".
	if containers, err := a.docker.ContainerList(r.Context()); err == nil {
		for _, c := range containers {
			if c.Name == name {
				writeError(w, http.StatusConflict, "a container named "+name+" already exists on this host")
				return
			}
		}
	}

	// The data directory is always DataRoot/<slug> — the slug pattern
	// forbids traversal, and nothing else about the location is
	// caller-controlled.
	dataDir := filepath.Join(a.cfg.DataRoot, req.Slug)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "creating data dir: "+err.Error())
		return
	}
	if req.RunAs != "" {
		parts := strings.SplitN(req.RunAs, ":", 2)
		uid, _ := strconv.Atoi(parts[0])
		gid, _ := strconv.Atoi(parts[1])
		if err := os.Chown(dataDir, uid, gid); err != nil {
			// Non-fatal only if the dir is already writable by the user;
			// SteamCMD will tell on it loudly otherwise.
			a.cfg.Logger.Warn("could not chown data dir", "dir", dataDir, "error", err)
		}
	}

	image := "ghcr.io/safwyls/palagent:" + req.ImageTag
	if err := a.docker.ImagePull(r.Context(), image); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	env := []string{
		"HOME=/tmp",
		"PALAGENT_MODE=supervisor",
		"PALAGENT_TOKEN=" + req.Token,
		"PALAGENT_ADMIN_PASSWORD=" + req.AdminPassword,
	}
	if req.ServerName != "" {
		env = append(env, "PALAGENT_SERVER_NAME="+req.ServerName)
	}
	if req.ServerDesc != "" {
		env = append(env, "PALAGENT_SERVER_DESC="+req.ServerDesc)
	}
	id, err := a.docker.ContainerCreate(r.Context(), dockerctl.ContainerSpec{
		Name:  name,
		Image: image,
		User:  req.RunAs,
		Env:   env,
		Binds: []string{dataDir + ":/palworld"},
		Ports: map[int]string{
			req.GamePort:  "8211/udp",
			req.RESTPort:  "8212/tcp",
			req.RCONPort:  "25575/tcp",
			req.AgentPort: "8811/tcp",
		},
		Labels:               map[string]string{"palcon.provisioned": "true", "palcon.slug": req.Slug},
		RestartUnlessStopped: true,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := a.docker.Start(r.Context(), name); err != nil {
		writeError(w, http.StatusBadGateway, "created but failed to start: "+err.Error())
		return
	}
	a.cfg.Logger.Info("provisioned server", "container", name, "dataDir", dataDir, "image", image)
	writeJSON(w, http.StatusCreated, map[string]any{
		"container": name,
		"id":        id,
		"dataDir":   dataDir,
	})
}

// ProvisionDefaults is what the wizard can infer instead of asking: the
// provisioner's own configuration is the source of truth for where and
// how servers land on this host.
type ProvisionDefaults struct {
	DataRoot string `json:"dataRoot"`
	// PublicHost is the address palcon (and players) reach this host on —
	// PALAGENT_PUBLIC_HOST. Inside containers "localhost" means the
	// container itself, so this must be declared, not guessed.
	PublicHost string `json:"publicHost,omitempty"`
	RunAs      string `json:"runAs"`
	ImageTag   string `json:"imageTag"`
}

// DiscoveredServer is one Palworld-shaped container found on the host.
// Deliberately free of environment values: a container's env carries its
// token and admin password, and those never leave the provisioner.
type DiscoveredServer struct {
	Name    string `json:"name"`
	Image   string `json:"image"`
	Mode    string `json:"mode"` // supervisor | companion | "" (unknown)
	Running bool   `json:"running"`
	// Published host ports for the well-known container ports.
	GamePort  int `json:"gamePort,omitempty"`
	RESTPort  int `json:"restPort,omitempty"`
	RCONPort  int `json:"rconPort,omitempty"`
	AgentPort int `json:"agentPort,omitempty"`
}

// handleDiscover lists palagent-shaped containers on the host so the add
// dialog can offer existing installs for adoption.
func (a *Agent) handleDiscover(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != "provisioner" {
		writeError(w, http.StatusBadRequest, "agent is not a provisioner")
		return
	}
	containers, err := a.docker.ContainerList(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	var out []DiscoveredServer
	for _, c := range containers {
		if !strings.Contains(c.Image, "palagent") && c.Labels["palcon.provisioned"] != "true" {
			continue
		}
		mode := ""
		if env, err := a.docker.InspectEnv(r.Context(), c.ID); err == nil {
			for _, e := range env {
				// Only the mode crosses the boundary — never other env.
				if v, ok := strings.CutPrefix(e, "PALAGENT_MODE="); ok {
					mode = v
				}
			}
		}
		if mode == "provisioner" {
			continue // that's us (or a peer), not a game server
		}
		if mode == "" {
			mode = "companion" // palagent's default mode
		}
		out = append(out, DiscoveredServer{
			Name:      c.Name,
			Image:     c.Image,
			Mode:      mode,
			Running:   c.State == "running",
			GamePort:  c.Ports["8211/udp"],
			RESTPort:  c.Ports["8212/tcp"],
			RCONPort:  c.Ports["25575/tcp"],
			AgentPort: c.Ports["8811/tcp"],
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": out})
}

// AdoptResult carries everything palcon needs to re-register an existing
// palagent container — including its secrets. Deliberately: the
// provisioner created these containers and injected those secrets in the
// first place, so returning them to the (token-authenticated) control
// plane stays within the same trust boundary. It is still restricted to
// palagent containers — never arbitrary ones.
type AdoptResult struct {
	Name          string `json:"name"`
	Mode          string `json:"mode"`
	ServerName    string `json:"serverName,omitempty"`
	Token         string `json:"token"`
	AdminPassword string `json:"adminPassword"`
	GamePort      int    `json:"gamePort,omitempty"`
	RESTPort      int    `json:"restPort,omitempty"`
	RCONPort      int    `json:"rconPort,omitempty"`
	AgentPort     int    `json:"agentPort,omitempty"`
}

// handleAdopt recovers a discovered container's registration data —
// the answer to "I deleted the server row; its container is still
// running and I no longer have the token".
func (a *Agent) handleAdopt(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != "provisioner" {
		writeError(w, http.StatusBadRequest, "agent is not a provisioner")
		return
	}
	var req struct {
		Container string `json:"container"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Container == "" {
		writeError(w, http.StatusBadRequest, "container name is required")
		return
	}
	containers, err := a.docker.ContainerList(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	for _, c := range containers {
		if c.Name != req.Container {
			continue
		}
		if !strings.Contains(c.Image, "palagent") && c.Labels["palcon.provisioned"] != "true" {
			writeError(w, http.StatusBadRequest, "not a palagent container")
			return
		}
		env, err := a.docker.InspectEnv(r.Context(), c.ID)
		if err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		res := AdoptResult{
			Name:      c.Name,
			Mode:      "companion",
			GamePort:  c.Ports["8211/udp"],
			RESTPort:  c.Ports["8212/tcp"],
			RCONPort:  c.Ports["25575/tcp"],
			AgentPort: c.Ports["8811/tcp"],
		}
		for _, e := range env {
			if v, ok := strings.CutPrefix(e, "PALAGENT_MODE="); ok {
				res.Mode = v
			}
			if v, ok := strings.CutPrefix(e, "PALAGENT_TOKEN="); ok {
				res.Token = v
			}
			if v, ok := strings.CutPrefix(e, "PALAGENT_ADMIN_PASSWORD="); ok {
				res.AdminPassword = v
			}
			if v, ok := strings.CutPrefix(e, "PALAGENT_SERVER_NAME="); ok {
				res.ServerName = v
			}
		}
		if res.Mode == "provisioner" {
			writeError(w, http.StatusBadRequest, "that container is a provisioner, not a game server")
			return
		}
		a.cfg.Logger.Info("adoption data served", "container", c.Name)
		writeJSON(w, http.StatusOK, res)
		return
	}
	writeError(w, http.StatusNotFound, "no container with that name")
}

// DestroyResult reports what the destroy verb unmade. DataDir comes back
// so the operator learns where the world still is — destroying a
// container is not consent to delete a save.
type DestroyResult struct {
	Container string `json:"container"`
	DataDir   string `json:"dataDir,omitempty"`
}

// handleDestroy removes a container this provisioner created.
//
// The label gate is the whole security argument. `palcon.provisioned=true`
// is written in exactly one place — handleProvision — so destroy can only
// ever unmake what provision made. That is deliberately narrower than
// discover/adopt, which also match on the palagent image name: a
// hand-deployed palagent (a TrueNAS app, a pasted stack) is something the
// operator manages elsewhere, and this verb must not reach into it. So a
// leaked provisioner token buys the ability to delete containers that
// same token's provisioner created, and nothing else on the host.
//
// The container's volume is never removed — the world lives in a host
// bind mount under the data root and outlives the container it was
// created for.
func (a *Agent) handleDestroy(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != "provisioner" {
		writeError(w, http.StatusBadRequest, "agent is not a provisioner")
		return
	}
	var req struct {
		Container string `json:"container"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Container) == "" {
		writeError(w, http.StatusBadRequest, "container name is required")
		return
	}
	name := strings.TrimSpace(req.Container)

	containers, err := a.docker.ContainerList(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	for _, c := range containers {
		if c.Name != name {
			continue
		}
		if c.Labels["palcon.provisioned"] != "true" {
			writeError(w, http.StatusBadRequest,
				"that container was not created by this provisioner — remove it wherever it was deployed")
			return
		}
		// Stop first so the supervisor gets its grace period and the game
		// flushes the world: the save this leaves behind is the whole
		// reason the data dir is kept. A stop that fails is not fatal on
		// its own — docker refuses to remove a running container, and its
		// 409 says so more usefully than anything invented here.
		if err := a.docker.Stop(r.Context(), c.ID); err != nil {
			a.cfg.Logger.Warn("stop before destroy failed; attempting remove anyway",
				"container", name, "error", err)
		}
		if err := a.docker.ContainerRemove(r.Context(), c.ID); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		dataDir := ""
		if slug := c.Labels["palcon.slug"]; slug != "" {
			dataDir = filepath.Join(a.cfg.DataRoot, slug)
		}
		a.cfg.Logger.Info("destroyed server", "container", name, "dataKept", dataDir)
		writeJSON(w, http.StatusOK, DestroyResult{Container: name, DataDir: dataDir})
		return
	}
	writeError(w, http.StatusNotFound, "no container with that name")
}

// validateProvisionerConfig is called from New for mode=provisioner.
func validateProvisionerConfig(cfg *Config) (*dockerctl.Client, error) {
	if cfg.DataRoot == "" {
		return nil, errors.New("provisioner mode requires a data root")
	}
	if !filepath.IsAbs(cfg.DataRoot) {
		return nil, errors.New("data root must be absolute")
	}
	if cfg.DockerHost == "" {
		cfg.DockerHost = "unix:///var/run/docker.sock"
	}
	if cfg.DefaultRunAs == "" {
		cfg.DefaultRunAs = "568:568"
	}
	if cfg.DefaultImageTag == "" {
		cfg.DefaultImageTag = "latest"
	}
	return dockerctl.New(cfg.DockerHost)
}

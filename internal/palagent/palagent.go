// Package palagent is the sidecar agent that sits next to one Palworld
// game server, holding the install volume and the SteamCMD tooling so
// palcon can stay a pure control plane. See docs/sidecar-agent.md.
//
// The API is a fixed set of dashboard-shaped verbs — never a generic exec
// or an arbitrary path parameter — so a compromised palcon (or a leaked
// token) can repair one game server and nothing else. Long-running work
// runs as a job: POST starts it and returns immediately, palcon polls; a
// palcon restart mid-job orphans nothing.
package palagent

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/safwyls/palcon/internal/dockerctl"
	"github.com/safwyls/palcon/internal/steamcmd"
)

// APIVersion is reported in /v1/health so palcon can refuse to drive an
// agent it doesn't understand (and vice versa) instead of failing weirdly.
// 1 = steam verbs; 2 adds the file verbs (save bundle, config); 3 adds
// supervisor mode's power verbs and game status.
const APIVersion = 3

// DefaultAppID is the Steam app the agent updates when none is configured:
// the Palworld dedicated server, which is what every existing deployment
// expects. Set PALAGENT_APPID to point the agent at a different one.
//
// Spelled out here rather than read from internal/games/palworld, on purpose.
// The agent is a thin sidecar — file access, process control, SteamCMD — and
// importing a game package for one integer would link the game registry and
// the RCON client it never speaks into every agent binary, and run a
// registration nothing here queries. A Steam app id is a fixed number, so the
// duplication cannot drift.
const DefaultAppID = 2394010

// minTokenLen is the floor for the shared token; the agent refuses to
// start below it rather than run guessably authenticated.
const minTokenLen = 16

type Config struct {
	// Token is the shared bearer token palcon presents. Required.
	Token string
	// InstallDir is the Palworld install root (the directory holding
	// steamapps/), shared with the game server container via the volume.
	InstallDir string
	// SteamCmd is the steamcmd binary to exec for update jobs.
	SteamCmd string
	// AppID is the Steam app to update; defaults to DefaultAppID.
	AppID int
	// Mode is "companion" (default: the game runs in its own container)
	// or "supervisor" (this agent runs the game as a child process and
	// owns its lifecycle — docs/sidecar-agent.md phase 3).
	Mode string
	// GameCommand is the launcher relative to InstallDir; defaults to
	// ./PalServer.sh. Supervisor mode only.
	GameCommand string
	// GameArgs are the launcher's flags; defaults to the standard
	// dedicated-server set. Supervisor mode only.
	GameArgs []string
	// StopGrace is how long a SIGTERM'd game gets before SIGKILL;
	// defaults to 30s.
	StopGrace time.Duration
	// AdminPassword, when set, is enforced into PalWorldSettings.ini
	// before every game start — along with RCONEnabled/RESTAPIEnabled —
	// so a supervised server is manageable by construction. Palworld
	// ships with both interfaces disabled, which otherwise leaves a
	// freshly provisioned server running but deaf to the dashboard.
	// Authoritative: an ini edit to these three keys is re-applied from
	// here on the next start. Supervisor mode only.
	AdminPassword string
	// ServerName/ServerDesc seed the in-game ServerName and
	// ServerDescription (MOTD) — applied only when the ini is first
	// created, so later settings-editor edits stick. Supervisor mode only.
	ServerName string
	ServerDesc string
	// Autostart starts the game on agent boot when no persisted desired
	// state exists yet (a fresh provision). Defaults true in supervisor
	// mode; a persisted "stopped" always wins.
	Autostart *bool
	// RestartBackoffFloor is the first crash-restart delay (doubling per
	// consecutive failure); defaults to 5s. Tests shrink it.
	RestartBackoffFloor time.Duration
	// DockerHost and DataRoot configure provisioner mode: the docker
	// endpoint holding create rights, and the directory per-server data
	// dirs are created under. Provisioner mode only.
	DockerHost string
	DataRoot   string
	// PublicHost/DefaultRunAs/DefaultImageTag are the provisioner's
	// wizard defaults, reported in /v1/health so palcon can prefill
	// instead of asking. Provisioner mode only.
	PublicHost      string
	DefaultRunAs    string
	DefaultImageTag string
	// Version is the agent build version, reported in /v1/health.
	Version string
	Logger  *slog.Logger
}

type Agent struct {
	cfg  Config
	jobs *jobRunner
	// game is non-nil only in supervisor mode.
	game *supervisor
	// docker is non-nil only in provisioner mode.
	docker *dockerctl.Client
}

// New validates the config and builds the agent. It does not listen;
// callers mount Handler() wherever they like (main, or a test server).
// In supervisor mode, call Run to kick off install/autostart.
func New(cfg Config) (*Agent, error) {
	if len(cfg.Token) < minTokenLen {
		return nil, fmt.Errorf("agent token must be at least %d characters", minTokenLen)
	}
	if cfg.InstallDir == "" {
		return nil, errors.New("install dir is required")
	}
	if cfg.SteamCmd == "" {
		cfg.SteamCmd = "steamcmd"
	}
	if cfg.AppID == 0 {
		cfg.AppID = DefaultAppID
	}
	if cfg.Mode == "" {
		cfg.Mode = "companion"
	}
	if cfg.Mode != "companion" && cfg.Mode != "supervisor" && cfg.Mode != "provisioner" {
		return nil, fmt.Errorf("unknown mode %q: use companion, supervisor or provisioner", cfg.Mode)
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	a := &Agent{cfg: cfg, jobs: newJobRunner(cfg.Logger)}
	if cfg.Mode == "supervisor" {
		a.game = newSupervisor(cfg, func() bool {
			cur := a.jobs.current()
			return cur != nil && cur.State == "running"
		})
	}
	if cfg.Mode == "provisioner" {
		docker, err := validateProvisionerConfig(&a.cfg)
		if err != nil {
			return nil, fmt.Errorf("provisioner mode: %w", err)
		}
		a.docker = docker
	}
	return a, nil
}

// Run performs supervisor-mode boot: install the game if it's missing
// (visible as a normal job), then start it unless the operator last asked
// for stopped. A no-op in companion mode. Blocks only while polling an
// install job, so callers run it in a goroutine.
func (a *Agent) Run() {
	if a.game == nil {
		return
	}
	if !a.game.Installed() {
		a.cfg.Logger.Info("game not installed; installing", "dir", a.cfg.InstallDir)
		args := steamcmd.UpdateArgs(a.cfg.InstallDir, a.cfg.AppID, true)
		job, err := a.jobs.start("steam-install", a.cfg.SteamCmd, args)
		if err != nil {
			a.cfg.Logger.Error("install could not start", "error", err)
			return
		}
		for {
			time.Sleep(2 * time.Second)
			j := a.jobs.get(job.ID)
			if j.State == "failed" {
				a.cfg.Logger.Error("install failed; not starting the game", "error", j.Error)
				return
			}
			if j.State == "done" {
				break
			}
		}
	}

	autostart := a.cfg.Autostart == nil || *a.cfg.Autostart
	fallback := "stopped"
	if autostart {
		fallback = "running"
	}
	if a.game.loadDesired(fallback) == "running" {
		if err := a.game.Start(); err != nil {
			a.cfg.Logger.Error("boot start failed", "error", err)
		}
	} else {
		a.cfg.Logger.Info("game stays stopped (persisted desired state)")
	}
}

func (a *Agent) Handler() http.Handler {
	r := chi.NewRouter()
	// Bare liveness for container healthchecks: no auth, no body, no
	// information.
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	r.Route("/v1", func(r chi.Router) {
		r.Use(a.requireToken)
		r.Get("/health", a.handleHealth)
		r.Post("/steam/clear-cache", a.handleClearCache)
		r.Post("/steam/update", a.handleStartUpdate)
		r.Get("/jobs/{jobID}", a.handleGetJob)
		// Phase 2 file verbs — fixed locations only, never a path
		// parameter (docs/sidecar-agent.md).
		r.Get("/files/save", a.handleGetSave)
		r.Get("/files/config", a.handleGetConfig)
		r.Put("/files/config", a.handlePutConfig)
		// Phase 3 power verbs — supervisor mode only; companion agents
		// answer 400 so palcon falls back to the docker proxy.
		r.Post("/power/{action}", a.handlePower)
		r.Get("/power/logs", a.handleGameLogs)
		// Phase 5 — provisioner mode: the create verb, read-only
		// discovery, and adoption (secret recovery for palagent
		// containers the control plane lost track of).
		r.Post("/provision", a.handleProvision)
		r.Get("/discover", a.handleDiscover)
		r.Post("/adopt", a.handleAdopt)
		// Destroy is create's inverse and is gated on the label create
		// writes, so it reaches only containers this provisioner made.
		r.Post("/destroy", a.handleDestroy)
	})
	return r
}

// requireToken checks the bearer token in constant time. Hashing first
// makes the comparison length-independent, so a mismatched length doesn't
// return early.
func (a *Agent) requireToken(next http.Handler) http.Handler {
	want := sha256.Sum256([]byte(a.cfg.Token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		gotHash := sha256.Sum256([]byte(got))
		if subtle.ConstantTimeCompare(want[:], gotHash[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "invalid agent token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Health is the /v1/health payload — everything palcon needs to decide
// what this agent can do and whether work is in flight.
type Health struct {
	Agent        string `json:"agent"`
	Version      string `json:"version"`
	APIVersion   int    `json:"apiVersion"`
	Mode         string `json:"mode"`
	InstallDir   string `json:"installDir"`
	InstallDirOk bool   `json:"installDirOk"`
	// SaveFound/ConfigFound report whether the phase 2 file verbs have
	// anything to serve, so palcon can distinguish "not synced yet" from
	// "this install has no world".
	SaveFound     bool   `json:"saveFound"`
	ConfigFound   bool   `json:"configFound"`
	DiskFreeBytes uint64 `json:"diskFreeBytes"`
	// Game is the supervised process's state; nil in companion mode.
	Game *GameStatus `json:"game,omitempty"`
	// Provision carries the wizard defaults; nil outside provisioner mode.
	Provision *ProvisionDefaults `json:"provision,omitempty"`
	// Job is the running job if there is one, else the most recently
	// finished one, else null. Exposing it here (not only under /jobs)
	// lets palcon rediscover in-flight work after its own restart.
	Job *Job `json:"job"`
}

func (a *Agent) handleHealth(w http.ResponseWriter, _ *http.Request) {
	installOk := false
	if _, err := os.Stat(a.cfg.InstallDir); err == nil {
		installOk = true
	}
	_, saveErr := a.findSaveDir()
	_, configErr := os.Stat(a.configPath())
	h := Health{
		Agent:         "palagent",
		Version:       a.cfg.Version,
		APIVersion:    APIVersion,
		Mode:          a.cfg.Mode,
		InstallDir:    a.cfg.InstallDir,
		InstallDirOk:  installOk,
		SaveFound:     saveErr == nil,
		ConfigFound:   configErr == nil,
		DiskFreeBytes: diskFree(a.cfg.InstallDir),
		Job:           a.jobs.current(),
	}
	if a.game != nil {
		st := a.game.Status()
		h.Game = &st
	}
	if a.cfg.Mode == "provisioner" {
		h.Provision = &ProvisionDefaults{
			DataRoot:   a.cfg.DataRoot,
			PublicHost: a.cfg.PublicHost,
			RunAs:      a.cfg.DefaultRunAs,
			ImageTag:   a.cfg.DefaultImageTag,
		}
	}
	writeJSON(w, http.StatusOK, h)
}

func (a *Agent) handleClearCache(w http.ResponseWriter, _ *http.Request) {
	removed, err := steamcmd.ClearCache(a.cfg.InstallDir)
	if err != nil {
		if errors.Is(err, steamcmd.ErrNotInstallRoot) {
			writeError(w, http.StatusBadRequest, err.Error()+" (agent install dir: "+a.cfg.InstallDir+")")
			return
		}
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.cfg.Logger.Info("steam cache cleared", "removed", removed)
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed})
}

func (a *Agent) handleStartUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Validate bool `json:"validate"`
	}
	// An empty body means default options, not a malformed request.
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// The install dir is a volume mount in any real deployment; its absence
	// means the agent is pointed somewhere wrong, and force_install_dir
	// would silently create a fresh install there.
	if _, err := os.Stat(a.cfg.InstallDir); err != nil {
		writeError(w, http.StatusBadRequest, "install dir does not exist: "+a.cfg.InstallDir)
		return
	}
	// In supervisor mode the agent knows the game's state first-hand:
	// SteamCMD must never rewrite files under a live server.
	if a.game != nil && a.game.Running() {
		writeError(w, http.StatusConflict, "stop the server before updating")
		return
	}

	args := steamcmd.UpdateArgs(a.cfg.InstallDir, a.cfg.AppID, req.Validate)
	job, err := a.jobs.start("steam-update", a.cfg.SteamCmd, args)
	if errors.Is(err, errJobRunning) {
		writeError(w, http.StatusConflict, "a job is already running")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	a.cfg.Logger.Info("steam update started", "job", job.ID, "validate", req.Validate)
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job})
}

func (a *Agent) handleGetJob(w http.ResponseWriter, r *http.Request) {
	job := a.jobs.get(chi.URLParam(r, "jobID"))
	if job == nil {
		writeError(w, http.StatusNotFound, "job not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

// maxGracefulWait caps how long a caller may ask the supervisor to wait
// for the game to exit on its own, so a bad value can't wedge a stop.
const maxGracefulWait = 2 * time.Minute

// parseGraceful reads the ?graceful= duration, collapsing anything absent,
// malformed, or negative to "don't wait".
func parseGraceful(v string) time.Duration {
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0
	}
	return min(d, maxGracefulWait)
}

// handlePower starts/stops/restarts the supervised game. The response is
// the post-action status, so palcon needs no follow-up read.
func (a *Agent) handlePower(w http.ResponseWriter, r *http.Request) {
	if a.game == nil {
		writeError(w, http.StatusBadRequest, "agent is in companion mode — the game runs in its own container")
		return
	}
	// graceful is how long an in-game shutdown the caller already requested
	// gets to finish before the supervisor signals the process. Palcon sets
	// it after its REST /shutdown courtesy is accepted; absent, stops
	// escalate immediately as before.
	graceful := parseGraceful(r.URL.Query().Get("graceful"))
	var err error
	switch action := chi.URLParam(r, "action"); action {
	case "start":
		err = a.game.Start()
	case "stop":
		err = a.game.Stop(graceful)
	case "restart":
		err = a.game.Restart(graceful)
	default:
		writeError(w, http.StatusBadRequest, "unknown action")
		return
	}
	if errors.Is(err, errJobInFlight) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"game": a.game.Status()})
}

func (a *Agent) handleGameLogs(w http.ResponseWriter, r *http.Request) {
	if a.game == nil {
		writeError(w, http.StatusBadRequest, "agent is in companion mode — read the game container's logs instead")
		return
	}
	tail := 300
	if n, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil && n > 0 {
		tail = min(n, gameLogTail)
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": a.game.Logs(tail)})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func newJobID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

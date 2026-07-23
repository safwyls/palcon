// Package palworld talks to a Palworld dedicated server, either through its
// REST API (preferred, JSON over HTTP) or the Source RCON protocol
// (fallback, for servers with the REST API disabled or on older builds).
// Both transports implement the same Client interface so the rest of the
// app never needs to know which one is in use.
package palworld

import "context"

type ServerInfo struct {
	ServerName  string `json:"servername"`
	Version     string `json:"version"`
	PlayerCount int    `json:"playerCount"`
	// Transport reports which transport actually served this request:
	// "rest" or "rcon". With PreferREST set, this can differ from the
	// server's configured preference if REST was unreachable and the
	// client fell back to RCON.
	Transport string `json:"transport"`
}

type Player struct {
	Name       string  `json:"name"`
	PlayerUID  string  `json:"playerId"` // steam/platform id, used for kick/ban
	UserID     string  `json:"userId"`
	Level      int     `json:"level"`
	Ping       float64 `json:"ping"`
	LocationX  float64 `json:"location_x"`
	LocationY  float64 `json:"location_y"`
}

// Client is the set of operations palcon needs from a Palworld server,
// regardless of transport.
type Client interface {
	Info(ctx context.Context) (*ServerInfo, error)
	Players(ctx context.Context) ([]Player, error)
	Broadcast(ctx context.Context, message string) error
	Kick(ctx context.Context, playerUID, message string) error
	Ban(ctx context.Context, playerUID, message string) error
	Unban(ctx context.Context, playerUID string) error
	Save(ctx context.Context) error
	Shutdown(ctx context.Context, waitSeconds int, message string) error
}

type Metrics struct {
	ServerFPS        float64 `json:"serverfps"`
	ServerFrameTime  float64 `json:"serverframetime"`
	CurrentPlayerNum int     `json:"currentplayernum"`
	MaxPlayerNum     int     `json:"maxplayernum"`
	UptimeSeconds    int     `json:"uptime"`
	Days             int     `json:"days"`
}

// ExtendedClient is REST-only functionality with no RCON equivalent —
// Palworld's RCON command set has nothing corresponding to the settings
// dump or metrics endpoints. Only RESTClient (and fallbackClient, when its
// primary is REST) implement it; a plain *RCONClient does not, so a type
// assertion (`c, ok := client.(ExtendedClient)`) is how callers detect
// whether a given server's configured transport supports these calls.
type ExtendedClient interface {
	Settings(ctx context.Context) (map[string]any, error)
	Metrics(ctx context.Context) (*Metrics, error)
}

// Config carries connection details for a single server. Passwords are
// expected to already be decrypted by the caller.
type Config struct {
	Host         string
	RESTPort     int
	RESTPassword string
	RCONPort     int
	RCONPassword string
	// PreferREST controls which transport New returns. When true, an
	// unreachable REST API falls back to RCON automatically.
	PreferREST bool
}

// New builds a Client for the given server config, using REST when
// preferred and falling back to RCON if the REST API call fails.
func New(cfg Config) Client {
	rcon := &RCONClient{
		addr:     addr(cfg.Host, cfg.RCONPort),
		password: cfg.RCONPassword,
	}
	if !cfg.PreferREST {
		return rcon
	}

	rest := &RESTClient{
		baseURL:  "http://" + addr(cfg.Host, cfg.RESTPort),
		password: cfg.RESTPassword,
	}
	return &fallbackClient{primary: rest, fallback: rcon}
}

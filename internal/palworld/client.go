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

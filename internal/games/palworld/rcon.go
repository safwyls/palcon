package palworld

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/safwyls/palcon/internal/game"
	"github.com/safwyls/palcon/internal/rcon"
)

// RCONClient is Palworld's command vocabulary on top of the generic Source
// RCON transport: which command strings exist, and how their plain-text
// replies parse. The wire protocol itself lives in internal/rcon.
type RCONClient struct {
	addr     string
	password string
	timeout  time.Duration
}

func (c *RCONClient) conn() *rcon.Client {
	return &rcon.Client{Addr: c.addr, Password: c.password, Timeout: c.timeout}
}

func (c *RCONClient) exec(ctx context.Context, command string) (string, error) {
	return c.conn().Exec(ctx, command)
}

func (c *RCONClient) Info(ctx context.Context) (*game.ServerInfo, error) {
	out, err := c.exec(ctx, "Info")
	if err != nil {
		return nil, err
	}
	info := &game.ServerInfo{ServerName: out, Transport: "rcon"}
	// Typical response: "Welcome to Pal Server[v0.1.2.3] MyServerName"
	if start := strings.Index(out, "] "); start != -1 {
		info.ServerName = strings.TrimSpace(out[start+2:])
		if vstart := strings.Index(out, "[v"); vstart != -1 {
			info.Version = out[vstart+2 : start]
		}
	}
	players, err := c.Players(ctx)
	if err == nil {
		info.PlayerCount = len(players)
	}
	return info, nil
}

func (c *RCONClient) Players(ctx context.Context) ([]game.Player, error) {
	out, err := c.exec(ctx, "ShowPlayers")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	players := make([]game.Player, 0, len(lines))
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if i == 0 || line == "" {
			continue // header row: name,playeruid,steamid
		}
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		p := game.Player{Name: fields[0], PlayerUID: fields[1]}
		if len(fields) > 2 {
			p.UserID = fields[2]
		}
		players = append(players, p)
	}
	return players, nil
}

func (c *RCONClient) Broadcast(ctx context.Context, message string) error {
	// Palworld's RCON Broadcast command splits on whitespace; underscores
	// render as spaces in-game.
	_, err := c.exec(ctx, "Broadcast "+strings.ReplaceAll(message, " ", "_"))
	return err
}

// Kick, Ban and Unban tolerate a dropped reply: Palworld executes them on
// receipt but answers by closing the connection on some builds, which used to
// surface as "failed" for a kick that visibly happened.

func (c *RCONClient) Kick(ctx context.Context, playerUID, message string) error {
	return c.conn().ExecTolerateDrop(ctx, "KickPlayer "+playerUID)
}

func (c *RCONClient) Ban(ctx context.Context, playerUID, message string) error {
	return c.conn().ExecTolerateDrop(ctx, "BanPlayer "+playerUID)
}

func (c *RCONClient) Unban(ctx context.Context, playerUID string) error {
	return c.conn().ExecTolerateDrop(ctx, "UnBanPlayer "+playerUID)
}

func (c *RCONClient) Save(ctx context.Context) error {
	_, err := c.exec(ctx, "Save")
	return err
}

func (c *RCONClient) Shutdown(ctx context.Context, waitSeconds int, message string) error {
	_, err := c.exec(ctx, "Shutdown "+strconv.Itoa(waitSeconds)+" "+strings.ReplaceAll(message, " ", "_"))
	return err
}

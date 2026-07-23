package palworld

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
)

// RCONClient speaks the Source RCON protocol, which Palworld dedicated
// servers implement with a small, fixed command set. It's used as a
// fallback when the REST API is unavailable or disabled.
type RCONClient struct {
	addr     string
	password string
	timeout  time.Duration
}

const (
	rconTypeExecCommand = 2
	rconTypeAuthResp    = 2
	rconTypeAuth        = 3
)

func (c *RCONClient) dialTimeout() time.Duration {
	if c.timeout > 0 {
		return c.timeout
	}
	return 10 * time.Second
}

// exec opens a fresh connection, authenticates, runs a single command, and
// returns its text response. A connection per command keeps the client
// simple (no auth-expiry or reconnect bookkeeping) at the cost of a little
// latency, which is fine for an admin tool.
func (c *RCONClient) exec(ctx context.Context, command string) (string, error) {
	d := net.Dialer{Timeout: c.dialTimeout()}
	conn, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return "", fmt.Errorf("rcon dial %s: %w", c.addr, err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	} else {
		conn.SetDeadline(time.Now().Add(c.dialTimeout()))
	}

	if err := writePacket(conn, 1, rconTypeAuth, c.password); err != nil {
		return "", fmt.Errorf("rcon auth: %w", err)
	}
	// Server may send an empty SERVERDATA_RESPONSE_VALUE before the auth
	// response; skip packets until we see the auth response type.
	for {
		id, typ, _, err := readPacket(conn)
		if err != nil {
			return "", fmt.Errorf("rcon auth response: %w", err)
		}
		if typ == rconTypeAuthResp {
			if id == -1 {
				return "", fmt.Errorf("rcon authentication failed (check rcon password)")
			}
			break
		}
	}

	if err := writePacket(conn, 2, rconTypeExecCommand, command); err != nil {
		return "", fmt.Errorf("rcon exec %q: %w", command, err)
	}
	_, _, body, err := readPacket(conn)
	if err != nil {
		return "", fmt.Errorf("rcon exec %q response: %w", command, err)
	}
	return body, nil
}

func writePacket(w io.Writer, id, packetType int32, body string) error {
	buf := &bytes.Buffer{}
	payload := &bytes.Buffer{}
	binary.Write(payload, binary.LittleEndian, id)
	binary.Write(payload, binary.LittleEndian, packetType)
	payload.WriteString(body)
	payload.WriteByte(0)
	payload.WriteByte(0)

	binary.Write(buf, binary.LittleEndian, int32(payload.Len()))
	buf.Write(payload.Bytes())
	_, err := w.Write(buf.Bytes())
	return err
}

func readPacket(r io.Reader) (id int32, packetType int32, body string, err error) {
	var size int32
	if err = binary.Read(r, binary.LittleEndian, &size); err != nil {
		return 0, 0, "", err
	}
	if size < 10 || size > 1<<20 {
		return 0, 0, "", fmt.Errorf("invalid rcon packet size %d", size)
	}

	data := make([]byte, size)
	if _, err = io.ReadFull(r, data); err != nil {
		return 0, 0, "", err
	}

	id = int32(binary.LittleEndian.Uint32(data[0:4]))
	packetType = int32(binary.LittleEndian.Uint32(data[4:8]))
	// body runs from byte 8 to size-2, trimming the two trailing null bytes.
	body = string(bytes.TrimRight(data[8:size-2], "\x00"))
	return id, packetType, body, nil
}

func (c *RCONClient) Info(ctx context.Context) (*ServerInfo, error) {
	out, err := c.exec(ctx, "Info")
	if err != nil {
		return nil, err
	}
	info := &ServerInfo{ServerName: out, Transport: "rcon"}
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

func (c *RCONClient) Players(ctx context.Context) ([]Player, error) {
	out, err := c.exec(ctx, "ShowPlayers")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	players := make([]Player, 0, len(lines))
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if i == 0 || line == "" {
			continue // header row: name,playeruid,steamid
		}
		fields := strings.Split(line, ",")
		if len(fields) < 2 {
			continue
		}
		p := Player{Name: fields[0], PlayerUID: fields[1]}
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

func (c *RCONClient) Kick(ctx context.Context, playerUID, message string) error {
	_, err := c.exec(ctx, "KickPlayer "+playerUID)
	return err
}

func (c *RCONClient) Ban(ctx context.Context, playerUID, message string) error {
	_, err := c.exec(ctx, "BanPlayer "+playerUID)
	return err
}

func (c *RCONClient) Unban(ctx context.Context, playerUID string) error {
	_, err := c.exec(ctx, "UnBanPlayer "+playerUID)
	return err
}

func (c *RCONClient) Save(ctx context.Context) error {
	_, err := c.exec(ctx, "Save")
	return err
}

func (c *RCONClient) Shutdown(ctx context.Context, waitSeconds int, message string) error {
	_, err := c.exec(ctx, "Shutdown "+strconv.Itoa(waitSeconds)+" "+strings.ReplaceAll(message, " ", "_"))
	return err
}

// Package rcon speaks the Source RCON protocol (Valve's SERVERDATA_* packet
// framing over TCP), with no knowledge of any particular game.
//
// The protocol is the same wherever it appears — Palworld, ARK, Conan Exiles,
// 7 Days to Die, Minecraft, Project Zomboid and the rest of the Source-derived
// server population all authenticate and exec identically. What differs per
// game is only the *vocabulary*: which command strings exist and how their
// text replies parse. That belongs to the game package; everything here is
// wire format.
package rcon

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"syscall"
	"time"
)

// Packet types from the Source RCON specification. AuthResponse and
// ExecCommand share the value 2 — the protocol distinguishes them by
// direction, not by number.
const (
	TypeExecCommand  int32 = 2
	TypeAuthResponse int32 = 2
	TypeAuth         int32 = 3
)

// DefaultTimeout bounds a dial and the exchange that follows. Kept short
// deliberately: RCON often sits behind a REST attempt that has already spent
// its own timeout, and the sum is what a human waits for before the UI says
// anything at all.
const DefaultTimeout = 5 * time.Second

// ErrAuthFailed is a rejected password — the server answered, so no amount of
// retrying or falling back to another transport will help.
var ErrAuthFailed = errors.New("rcon authentication failed (check rcon password)")

// Client is a connectionless RCON caller: every Exec opens a fresh
// connection, authenticates, runs one command and closes. That trades a
// little latency for having no auth-expiry, keepalive or reconnect
// bookkeeping to get wrong, which is the right trade for an admin tool
// issuing a command every few seconds at most.
type Client struct {
	Addr     string
	Password string
	// Timeout overrides DefaultTimeout when non-zero.
	Timeout time.Duration
}

func (c *Client) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return DefaultTimeout
}

// Exec runs one command and returns the server's text response.
func (c *Client) Exec(ctx context.Context, command string) (string, error) {
	return c.exec(ctx, command, false)
}

// ExecTolerateDrop is Exec for commands a server executes on receipt but
// answers by simply closing the connection. Several games do this for their
// kick and ban commands, which otherwise surfaces as a failure for an action
// that visibly happened. Auth and write failures still fail; only a dropped
// reply *after* the command was written successfully is forgiven.
func (c *Client) ExecTolerateDrop(ctx context.Context, command string) error {
	_, err := c.exec(ctx, command, true)
	return err
}

// IsConnDrop reports whether an error is the far end closing or resetting the
// connection, as opposed to answering badly or timing out.
func IsConnDrop(err error) bool {
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET)
}

func (c *Client) exec(ctx context.Context, command string, tolerateDroppedReply bool) (string, error) {
	d := net.Dialer{Timeout: c.timeout()}
	conn, err := d.DialContext(ctx, "tcp", c.Addr)
	if err != nil {
		return "", fmt.Errorf("rcon dial %s: %w", c.Addr, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(c.timeout())
	if d, ok := ctx.Deadline(); ok {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return "", fmt.Errorf("rcon set deadline: %w", err)
	}

	if err := Write(conn, 1, TypeAuth, c.Password); err != nil {
		return "", fmt.Errorf("rcon auth: %w", err)
	}
	// A server may send an empty SERVERDATA_RESPONSE_VALUE ahead of the auth
	// response; skip packets until the auth response type shows up.
	for {
		id, typ, _, err := Read(conn)
		if err != nil {
			return "", fmt.Errorf("rcon auth response: %w", err)
		}
		if typ == TypeAuthResponse {
			if id == -1 {
				return "", ErrAuthFailed
			}
			break
		}
	}

	if err := Write(conn, 2, TypeExecCommand, command); err != nil {
		return "", fmt.Errorf("rcon exec %q: %w", command, err)
	}
	_, _, body, err := Read(conn)
	if err != nil {
		if tolerateDroppedReply && IsConnDrop(err) {
			return "", nil
		}
		return "", fmt.Errorf("rcon exec %q response: %w", command, err)
	}
	return body, nil
}

// Write frames and writes one RCON packet.
func Write(w io.Writer, id, packetType int32, body string) error {
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

// Read reads one RCON packet.
func Read(r io.Reader) (id int32, packetType int32, body string, err error) {
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

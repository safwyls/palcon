package rcon_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/rcon"
	"github.com/safwyls/palcon/internal/rcon/rcontest"
)

func TestPacketRoundTrip(t *testing.T) {
	for _, body := range []string{"", "hello", "Broadcast hello_world", strings.Repeat("x", 4000)} {
		var buf bytes.Buffer
		if err := rcon.Write(&buf, 7, rcon.TypeExecCommand, body); err != nil {
			t.Fatalf("write: %v", err)
		}
		id, typ, got, err := rcon.Read(&buf)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if id != 7 || typ != rcon.TypeExecCommand || got != body {
			t.Errorf("round-trip: id=%d typ=%d body=%q, want 7 %d %q", id, typ, got, rcon.TypeExecCommand, body)
		}
	}
}

func TestReadRejectsBadSizes(t *testing.T) {
	for _, size := range []int32{0, 9, 1 << 21} {
		var buf bytes.Buffer
		if err := rcon.Write(&buf, 1, 0, ""); err != nil {
			t.Fatal(err)
		}
		// Overwrite the size prefix with a bogus value.
		b := buf.Bytes()
		b[0], b[1], b[2], b[3] = byte(size), byte(size>>8), byte(size>>16), byte(size>>24)
		if _, _, _, err := rcon.Read(bytes.NewReader(b)); err == nil {
			t.Errorf("size %d: want error, got nil", size)
		}
	}
}

func TestAuthFailure(t *testing.T) {
	srv := rcontest.New(t, "right-password", "")
	c := &rcon.Client{Addr: srv.Addr(), Password: "wrong", Timeout: 2 * time.Second}

	_, err := c.Exec(context.Background(), "Info")
	if !errors.Is(err, rcon.ErrAuthFailed) {
		t.Errorf("want ErrAuthFailed, got %v", err)
	}
}

func TestSkipsPreAuthNoise(t *testing.T) {
	srv := rcontest.New(t, "pw", "pong")
	srv.SendPreAuthNoise()
	c := &rcon.Client{Addr: srv.Addr(), Password: "pw", Timeout: 2 * time.Second}

	out, err := c.Exec(context.Background(), "ping")
	if err != nil {
		t.Fatalf("exec: %v", err)
	}
	if out != "pong" {
		t.Errorf("response = %q, want pong", out)
	}
}

func TestExecTolerateDrop(t *testing.T) {
	srv := rcontest.New(t, "pw", "")
	srv.DropAfterCommand()
	c := &rcon.Client{Addr: srv.Addr(), Password: "pw", Timeout: 2 * time.Second}

	if err := c.ExecTolerateDrop(context.Background(), "KickPlayer 1"); err != nil {
		t.Errorf("tolerant exec with dropped reply: want success, got %v", err)
	}
	// A plain Exec must still report the drop.
	if _, err := c.Exec(context.Background(), "Broadcast hi"); err == nil {
		t.Error("plain exec with dropped reply: want error, got nil")
	}
}

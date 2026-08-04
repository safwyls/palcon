package palworld

import (
	"context"
	"testing"
	"time"

	"github.com/safwyls/palcon/internal/rcon/rcontest"
)

// These cover Palworld's command vocabulary — the exact strings put on the
// wire and how its replies parse. The wire protocol itself is tested in
// internal/rcon.

func clientFor(srv *rcontest.Server) *RCONClient {
	return &RCONClient{addr: srv.Addr(), password: "pw", timeout: 2 * time.Second}
}

func TestRCONShowPlayersParsing(t *testing.T) {
	// Header row, two normal rows, a short row (skipped), and a blank line.
	response := "name,playeruid,steamid\nSam,12345,7656119\nRen é,67890,7656120\nbroken\n\n"
	srv := rcontest.New(t, "pw", response)

	players, err := clientFor(srv).Players(context.Background())
	if err != nil {
		t.Fatalf("players: %v", err)
	}
	if len(players) != 2 {
		t.Fatalf("got %d players, want 2: %+v", len(players), players)
	}
	if players[0].Name != "Sam" || players[0].PlayerUID != "12345" || players[0].UserID != "7656119" {
		t.Errorf("first player wrong: %+v", players[0])
	}
	if players[1].Name != "Ren é" {
		t.Errorf("second player wrong: %+v", players[1])
	}
}

func TestRCONInfoParsing(t *testing.T) {
	srv := rcontest.New(t, "pw", "Welcome to Pal Server[v0.5.2.63216] My Cool Server")

	info, err := clientFor(srv).Info(context.Background())
	if err != nil {
		t.Fatalf("info: %v", err)
	}
	if info.ServerName != "My Cool Server" || info.Version != "0.5.2.63216" || info.Transport != "rcon" {
		t.Errorf("info = %+v", info)
	}
}

func TestRCONKickToleratesDroppedReply(t *testing.T) {
	srv := rcontest.New(t, "pw", "")
	srv.DropAfterCommand()

	if err := clientFor(srv).Kick(context.Background(), "7656119", "bye"); err != nil {
		t.Errorf("kick with dropped reply: want success, got %v", err)
	}
	if cmds := srv.Commands(); len(cmds) != 1 || cmds[0] != "KickPlayer 7656119" {
		t.Errorf("commands = %v, want [KickPlayer 7656119]", cmds)
	}
}

func TestRCONBroadcastStillFailsOnDroppedReply(t *testing.T) {
	// Only moderation commands are fire-and-forget; everything else must
	// keep reporting a dropped connection.
	srv := rcontest.New(t, "pw", "")
	srv.DropAfterCommand()

	if err := clientFor(srv).Broadcast(context.Background(), "hello"); err == nil {
		t.Error("broadcast with dropped reply: want error, got nil")
	}
}

func TestRCONBroadcastUnderscores(t *testing.T) {
	srv := rcontest.New(t, "pw", "")
	if err := clientFor(srv).Broadcast(context.Background(), "restart in 5"); err != nil {
		t.Fatalf("broadcast: %v", err)
	}
	if cmds := srv.Commands(); len(cmds) != 1 || cmds[0] != "Broadcast restart_in_5" {
		t.Errorf("commands = %v, want [Broadcast restart_in_5]", cmds)
	}
}

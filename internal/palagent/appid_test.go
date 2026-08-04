package palagent_test

import (
	"testing"

	"github.com/safwyls/palcon/internal/games/palworld"
	"github.com/safwyls/palcon/internal/palagent"
)

// The agent spells Palworld's Steam app id out itself rather than importing
// the game package, so that a thin sidecar doesn't link the game registry and
// the RCON client it never speaks (see palagent.DefaultAppID). This test is
// where the two are held together — a test-only import, so it costs the
// shipped binary nothing.
func TestDefaultAppIDMatchesPalworld(t *testing.T) {
	if palagent.DefaultAppID != palworld.AppID {
		t.Errorf("palagent.DefaultAppID = %d, palworld.AppID = %d — the agent would update the wrong app",
			palagent.DefaultAppID, palworld.AppID)
	}
}

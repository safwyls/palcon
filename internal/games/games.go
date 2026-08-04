// Package games registers every game palcon supports.
//
// Importing it for side effects — `_ "github.com/safwyls/palcon/internal/games"`
// — is what populates the game registry. Binaries and any test that resolves a
// server row to a client need exactly this one import; adding a game means
// adding one line here and nothing anywhere else.
//
// The registration itself lives in each game's own package (an init calling
// game.Register), so a game is self-describing and this file stays a list.
package games

import (
	_ "github.com/safwyls/palcon/internal/games/palworld"
)

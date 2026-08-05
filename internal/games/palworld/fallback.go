package palworld

import (
	"context"
	"errors"
	"fmt"

	"github.com/safwyls/palcon/internal/game"
)

// fallbackClient tries the REST API first and falls back to RCON only when
// REST failed at the transport level (connection refused, timeout — e.g.
// the REST API is disabled on this server). An HTTP-level reply means REST
// is up and the error is real: a wrong REST password must surface as a
// REST auth error, not be masked by an RCON retry.
type fallbackClient struct {
	primary  game.Client
	fallback game.Client
}

// shouldFallBack reports whether an error from the REST primary warrants
// retrying over RCON.
func shouldFallBack(err error) bool {
	var statusErr *restStatusError
	return !errors.As(err, &statusErr)
}

// call runs op against the REST primary, retrying over RCON when the
// failure was transport-level. When both attempts fail, both causes are
// reported — otherwise the RCON error hides why REST failed.
func (f *fallbackClient) call(op func(game.Client) error) error {
	err := op(f.primary)
	if err == nil {
		return nil
	}
	if !shouldFallBack(err) {
		return err
	}
	if ferr := op(f.fallback); ferr != nil {
		return errors.Join(fmt.Errorf("rest: %w", err), fmt.Errorf("rcon fallback: %w", ferr))
	}
	return nil
}

func (f *fallbackClient) Info(ctx context.Context) (*game.ServerInfo, error) {
	var info *game.ServerInfo
	err := f.call(func(c game.Client) error {
		var e error
		info, e = c.Info(ctx)
		return e
	})
	return info, err
}

func (f *fallbackClient) Players(ctx context.Context) ([]game.Player, error) {
	var players []game.Player
	err := f.call(func(c game.Client) error {
		var e error
		players, e = c.Players(ctx)
		return e
	})
	return players, err
}

func (f *fallbackClient) Broadcast(ctx context.Context, message string) error {
	return f.call(func(c game.Client) error { return c.Broadcast(ctx, message) })
}

func (f *fallbackClient) Kick(ctx context.Context, playerUID, message string) error {
	return f.call(func(c game.Client) error { return c.Kick(ctx, playerUID, message) })
}

func (f *fallbackClient) Ban(ctx context.Context, playerUID, message string) error {
	return f.call(func(c game.Client) error { return c.Ban(ctx, playerUID, message) })
}

func (f *fallbackClient) Unban(ctx context.Context, playerUID string) error {
	return f.call(func(c game.Client) error { return c.Unban(ctx, playerUID) })
}

func (f *fallbackClient) Save(ctx context.Context) error {
	return f.call(func(c game.Client) error { return c.Save(ctx) })
}

func (f *fallbackClient) Shutdown(ctx context.Context, waitSeconds int, message string) error {
	return f.call(func(c game.Client) error { return c.Shutdown(ctx, waitSeconds, message) })
}

// Settings and Metrics have no RCON equivalent, so there's nothing to fall
// back to — these just forward to the REST primary. fallbackClient is only
// ever constructed with a REST primary (see New in palworld.go), so this
// type assertion always succeeds.
func (f *fallbackClient) Settings(ctx context.Context) (map[string]any, error) {
	return f.primary.(game.ExtendedClient).Settings(ctx)
}

func (f *fallbackClient) Metrics(ctx context.Context) (*game.Metrics, error) {
	return f.primary.(game.ExtendedClient).Metrics(ctx)
}

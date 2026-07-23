package palworld

import "context"

// fallbackClient tries the REST API first and falls back to RCON if the
// REST call fails (e.g. the REST API is disabled on this server).
type fallbackClient struct {
	primary  Client
	fallback Client
}

func (f *fallbackClient) Info(ctx context.Context) (*ServerInfo, error) {
	if info, err := f.primary.Info(ctx); err == nil {
		return info, nil
	}
	return f.fallback.Info(ctx)
}

func (f *fallbackClient) Players(ctx context.Context) ([]Player, error) {
	if players, err := f.primary.Players(ctx); err == nil {
		return players, nil
	}
	return f.fallback.Players(ctx)
}

func (f *fallbackClient) Broadcast(ctx context.Context, message string) error {
	if err := f.primary.Broadcast(ctx, message); err == nil {
		return nil
	}
	return f.fallback.Broadcast(ctx, message)
}

func (f *fallbackClient) Kick(ctx context.Context, playerUID, message string) error {
	if err := f.primary.Kick(ctx, playerUID, message); err == nil {
		return nil
	}
	return f.fallback.Kick(ctx, playerUID, message)
}

func (f *fallbackClient) Ban(ctx context.Context, playerUID, message string) error {
	if err := f.primary.Ban(ctx, playerUID, message); err == nil {
		return nil
	}
	return f.fallback.Ban(ctx, playerUID, message)
}

func (f *fallbackClient) Unban(ctx context.Context, playerUID string) error {
	if err := f.primary.Unban(ctx, playerUID); err == nil {
		return nil
	}
	return f.fallback.Unban(ctx, playerUID)
}

func (f *fallbackClient) Save(ctx context.Context) error {
	if err := f.primary.Save(ctx); err == nil {
		return nil
	}
	return f.fallback.Save(ctx)
}

func (f *fallbackClient) Shutdown(ctx context.Context, waitSeconds int, message string) error {
	if err := f.primary.Shutdown(ctx, waitSeconds, message); err == nil {
		return nil
	}
	return f.fallback.Shutdown(ctx, waitSeconds, message)
}

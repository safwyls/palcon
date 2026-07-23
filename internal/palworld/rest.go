package palworld

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RESTClient talks to a Palworld server's built-in REST API
// (RESTAPIEnabled=True in PalWorldSettings.ini). Auth is HTTP Basic with
// username "admin" and the server's admin password.
type RESTClient struct {
	baseURL  string
	password string

	httpClient *http.Client
}

func (c *RESTClient) client() *http.Client {
	if c.httpClient != nil {
		return c.httpClient
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (c *RESTClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reqBody = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return err
	}
	req.SetBasicAuth("admin", c.password)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.client().Do(req)
	if err != nil {
		return fmt.Errorf("rest api request to %s: %w", path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode >= 300 {
		return fmt.Errorf("rest api %s returned %d: %s", path, resp.StatusCode, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("decoding response from %s: %w", path, err)
		}
	}
	return nil
}

func (c *RESTClient) Info(ctx context.Context) (*ServerInfo, error) {
	var info ServerInfo
	if err := c.do(ctx, http.MethodGet, "/v1/api/info", nil, &info); err != nil {
		return nil, err
	}
	players, err := c.Players(ctx)
	if err != nil {
		return nil, err
	}
	info.PlayerCount = len(players)
	return &info, nil
}

func (c *RESTClient) Players(ctx context.Context) ([]Player, error) {
	var out struct {
		Players []Player `json:"players"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/api/players", nil, &out); err != nil {
		return nil, err
	}
	return out.Players, nil
}

func (c *RESTClient) Broadcast(ctx context.Context, message string) error {
	return c.do(ctx, http.MethodPost, "/v1/api/announce", map[string]string{"message": message}, nil)
}

func (c *RESTClient) Kick(ctx context.Context, playerUID, message string) error {
	return c.do(ctx, http.MethodPost, "/v1/api/kick", map[string]string{"userid": playerUID, "message": message}, nil)
}

func (c *RESTClient) Ban(ctx context.Context, playerUID, message string) error {
	return c.do(ctx, http.MethodPost, "/v1/api/ban", map[string]string{"userid": playerUID, "message": message}, nil)
}

func (c *RESTClient) Unban(ctx context.Context, playerUID string) error {
	return c.do(ctx, http.MethodPost, "/v1/api/unban", map[string]string{"userid": playerUID}, nil)
}

func (c *RESTClient) Save(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/api/save", nil, nil)
}

func (c *RESTClient) Shutdown(ctx context.Context, waitSeconds int, message string) error {
	return c.do(ctx, http.MethodPost, "/v1/api/shutdown", map[string]any{
		"waittime": waitSeconds,
		"message":  message,
	}, nil)
}

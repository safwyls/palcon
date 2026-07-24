// Package dockerctl starts, stops and inspects the container a Palworld
// server runs in.
//
// It speaks the Docker Engine HTTP API, but is meant to be pointed at a
// scoped proxy (e.g. tecnativa/docker-socket-proxy) rather than the host's
// docker socket. Mounting that socket into this container would hand
// whoever compromises Palcon effective root on the host; a proxy that
// whitelists only container start/stop/restart limits the damage to
// bouncing a game server. Nothing here needs more than that.
package dockerctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrNotConfigured means no Docker endpoint was supplied, so power control
// is switched off rather than broken.
var ErrNotConfigured = errors.New("docker control is not configured")

type Client struct {
	http *http.Client
	// base is the URL prefix for API calls; for a unix socket the host part
	// is a placeholder the custom dialer ignores.
	base string
}

// State is the subset of container status the dashboard shows.
type State struct {
	Name      string `json:"name"`
	Status    string `json:"status"` // created, running, paused, exited, ...
	Running   bool   `json:"running"`
	StartedAt string `json:"startedAt"`
	ExitCode  int    `json:"exitCode"`
}

// New builds a client for a DOCKER_HOST-style endpoint: tcp://host:port,
// http://host:port, or unix:///path/to.sock. An empty host disables the
// feature.
func New(host string) (*Client, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, ErrNotConfigured
	}

	transport := &http.Transport{}
	base := ""

	switch {
	case strings.HasPrefix(host, "unix://"):
		socket := strings.TrimPrefix(host, "unix://")
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}
		base = "http://docker"
	case strings.HasPrefix(host, "tcp://"):
		base = "http://" + strings.TrimPrefix(host, "tcp://")
	case strings.HasPrefix(host, "http://"), strings.HasPrefix(host, "https://"):
		base = host
	default:
		return nil, fmt.Errorf("unsupported docker host %q: use tcp://, http:// or unix://", host)
	}

	// No client-wide timeout: each call sets its own below. A single
	// deadline can't cover both a fast inspect and a stop that legitimately
	// waits out the grace period.
	return &Client{
		base: strings.TrimSuffix(base, "/"),
		http: &http.Client{Transport: transport},
	}, nil
}

// stopGrace is how long Docker waits for the server to exit cleanly before
// killing it — long enough for Palworld to flush its world to disk.
const stopGrace = 30 * time.Second

// requestTimeout must exceed stopGrace by a clear margin. With the two
// equal, a stop that used its full grace period timed out client-side and
// reported failure for an action that actually succeeded.
const requestTimeout = stopGrace + 60*time.Second

func (c *Client) do(ctx context.Context, method, path string, timeout time.Duration) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("docker endpoint unreachable: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return body, resp.StatusCode, err
}

// dockerError turns an API failure into something worth showing a user.
// A 403 almost always means the socket proxy is running but hasn't been
// granted the permission in question, which is easy to fix and impossible
// to guess from "forbidden".
func dockerError(action string, status int, body []byte) error {
	msg := strings.TrimSpace(string(body))
	var parsed struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Message != "" {
		msg = parsed.Message
	}
	switch status {
	case http.StatusNotFound:
		return fmt.Errorf("container not found — check the container name")
	case http.StatusForbidden:
		return fmt.Errorf("the docker proxy refused %s; it likely needs POST=1 and CONTAINERS=1", action)
	}
	return fmt.Errorf("docker %s failed (%d): %s", action, status, msg)
}

func (c *Client) Inspect(ctx context.Context, container string) (*State, error) {
	body, status, err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(container)+"/json", 15*time.Second)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, dockerError("inspect", status, body)
	}

	var payload struct {
		Name  string `json:"Name"`
		State struct {
			Status    string `json:"Status"`
			Running   bool   `json:"Running"`
			StartedAt string `json:"StartedAt"`
			ExitCode  int    `json:"ExitCode"`
		} `json:"State"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parsing docker response: %w", err)
	}
	return &State{
		Name:      strings.TrimPrefix(payload.Name, "/"),
		Status:    payload.State.Status,
		Running:   payload.State.Running,
		StartedAt: payload.State.StartedAt,
		ExitCode:  payload.State.ExitCode,
	}, nil
}

func (c *Client) action(ctx context.Context, container, verb, query string) error {
	path := "/containers/" + url.PathEscape(container) + "/" + verb + query
	body, status, err := c.do(ctx, http.MethodPost, path, requestTimeout)
	if err != nil {
		return err
	}
	// 304 means already in the requested state — starting a running
	// container isn't a failure worth surfacing.
	if status == http.StatusNoContent || status == http.StatusNotModified {
		return nil
	}
	return dockerError(verb, status, body)
}

func (c *Client) Start(ctx context.Context, container string) error {
	return c.action(ctx, container, "start", "")
}

// Stop asks for a graceful shutdown, giving the server time to flush its
// world to disk before Docker resorts to SIGKILL.
func (c *Client) Stop(ctx context.Context, container string) error {
	return c.action(ctx, container, "stop", fmt.Sprintf("?t=%d", int(stopGrace.Seconds())))
}

func (c *Client) Restart(ctx context.Context, container string) error {
	return c.action(ctx, container, "restart", fmt.Sprintf("?t=%d", int(stopGrace.Seconds())))
}

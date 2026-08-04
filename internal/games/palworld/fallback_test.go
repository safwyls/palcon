package palworld

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/safwyls/palcon/internal/game"
)

// stubClient counts calls and fails every operation with err when set.
type stubClient struct {
	err   error
	calls int
}

func (s *stubClient) op() error {
	s.calls++
	return s.err
}

func (s *stubClient) Info(context.Context) (*game.ServerInfo, error) {
	if err := s.op(); err != nil {
		return nil, err
	}
	return &game.ServerInfo{Transport: "stub"}, nil
}

func (s *stubClient) Players(context.Context) ([]game.Player, error) {
	if err := s.op(); err != nil {
		return nil, err
	}
	return []game.Player{}, nil
}

func (s *stubClient) Broadcast(context.Context, string) error     { return s.op() }
func (s *stubClient) Kick(context.Context, string, string) error  { return s.op() }
func (s *stubClient) Ban(context.Context, string, string) error   { return s.op() }
func (s *stubClient) Unban(context.Context, string) error         { return s.op() }
func (s *stubClient) Save(context.Context) error                  { return s.op() }
func (s *stubClient) Shutdown(context.Context, int, string) error { return s.op() }

// A wrong REST password must surface as a REST auth error, not be retried
// (and masked) over RCON.
func TestFallbackSkipsRCONOnHTTPLevelError(t *testing.T) {
	rest := &stubClient{err: &restStatusError{path: "/v1/api/info", status: 401}}
	rcon := &stubClient{}
	f := &fallbackClient{primary: rest, fallback: rcon}

	_, err := f.Info(context.Background())
	if err == nil || !strings.Contains(err.Error(), "REST password") {
		t.Errorf("want a REST-auth error, got %v", err)
	}
	if rcon.calls != 0 {
		t.Errorf("rcon tried %d times after an HTTP-level REST error, want 0", rcon.calls)
	}
}

func TestFallbackRunsOnTransportError(t *testing.T) {
	rest := &stubClient{err: errors.New("dial tcp: connection refused")}
	rcon := &stubClient{}
	f := &fallbackClient{primary: rest, fallback: rcon}

	info, err := f.Info(context.Background())
	if err != nil || info == nil {
		t.Fatalf("want fallback success, got info=%v err=%v", info, err)
	}
	if rcon.calls != 1 {
		t.Errorf("rcon calls = %d, want 1", rcon.calls)
	}
}

// When both transports fail, both causes must be visible — the RCON error
// alone hides why REST failed.
func TestFallbackReportsBothFailures(t *testing.T) {
	rest := &stubClient{err: errors.New("dial tcp: connection refused")}
	rcon := &stubClient{err: errors.New("rcon dial: i/o timeout")}
	f := &fallbackClient{primary: rest, fallback: rcon}

	err := f.Broadcast(context.Background(), "hi")
	if err == nil {
		t.Fatal("want error when both transports fail")
	}
	for _, want := range []string{"rest:", "connection refused", "rcon fallback:", "i/o timeout"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

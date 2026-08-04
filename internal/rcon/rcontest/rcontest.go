// Package rcontest provides a loopback Source RCON server for tests.
//
// It lives outside the rcon package's own test file because every game
// implementation needs it: an RCON-backed client is tested by asserting the
// exact command strings it puts on the wire, and each game has its own
// vocabulary to assert.
package rcontest

import (
	"net"
	"sync"
	"testing"

	"github.com/safwyls/palcon/internal/rcon"
)

// Server speaks just enough Source RCON for a client: auth (optionally
// preceded by the empty response packet real servers send), then one command
// per connection.
type Server struct {
	ln       net.Listener
	password string
	response string

	mu               sync.Mutex
	preAuthNoise     bool
	commands         []string
	dropAfterCommand bool
}

// New starts a server that accepts password and answers every command with
// response. It is closed when the test ends.
func New(t *testing.T, password, response string) *Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &Server{ln: ln, password: password, response: response}
	t.Cleanup(func() { ln.Close() })
	go s.serve()
	return s
}

// Addr is the host:port to point a client at.
func (s *Server) Addr() string { return s.ln.Addr().String() }

// SendPreAuthNoise makes the server emit an empty SERVERDATA_RESPONSE_VALUE
// before the auth response, the way real servers do.
func (s *Server) SendPreAuthNoise() {
	s.mu.Lock()
	s.preAuthNoise = true
	s.mu.Unlock()
}

// DropAfterCommand makes the server close the connection after reading a
// command instead of replying — how several games answer kick and ban.
func (s *Server) DropAfterCommand() {
	s.mu.Lock()
	s.dropAfterCommand = true
	s.mu.Unlock()
}

// Commands returns every command string the server has received.
func (s *Server) Commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

func (s *Server) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	id, typ, body, err := rcon.Read(conn)
	if err != nil || typ != rcon.TypeAuth {
		return
	}
	if body != s.password {
		rcon.Write(conn, -1, rcon.TypeAuthResponse, "")
		return
	}
	s.mu.Lock()
	noise := s.preAuthNoise
	s.mu.Unlock()
	if noise {
		rcon.Write(conn, id, 0, "")
	}
	rcon.Write(conn, id, rcon.TypeAuthResponse, "")

	cmdID, _, cmd, err := rcon.Read(conn)
	if err != nil {
		return
	}
	s.mu.Lock()
	s.commands = append(s.commands, cmd)
	drop := s.dropAfterCommand
	s.mu.Unlock()
	if drop {
		return // deferred Close drops the connection with no reply
	}
	rcon.Write(conn, cmdID, 0, s.response)
}

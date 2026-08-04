package store

import "github.com/safwyls/palcon/internal/game"

// This file is the one place a stored server row becomes a live game client.
// It lives in store because store.Server is where the connection details are
// and the mapping is otherwise identical in three callers (the API handlers,
// the metrics collector and the restart scheduler) — which is exactly how the
// three drifted apart before.

// Definition returns the registered game this server runs. The bool is false
// for a row naming a game this build doesn't have, which is a downgrade or a
// hand-edited row rather than anything the UI can cause.
func (s *Server) Definition() (*game.Definition, bool) { return game.Get(s.Game) }

// Conn describes how to reach this server's admin interface. Passwords are
// already decrypted by the time a Server exists.
func (s *Server) Conn() game.Conn {
	return game.Conn{
		Host:         s.Host,
		RESTPort:     s.RESTPort,
		RESTPassword: s.RESTPassword,
		RCONPort:     s.RCONPort,
		RCONPassword: s.RCONPassword,
		PreferREST:   s.UseREST,
	}
}

// Client builds an admin client for this server.
func (s *Server) Client() (game.Client, error) {
	def, ok := s.Definition()
	if !ok {
		return nil, &game.UnknownGameError{ID: s.Game}
	}
	return def.NewClient(s.Conn()), nil
}

// CanonicalUID renders a live player id in the spelling this game's save
// files use. An unknown game returns the id untouched — a caller matching on
// it then finds nothing, which is the safe result for both a visibility check
// and a last-seen lookup.
func (s *Server) CanonicalUID(uid string) string {
	def, ok := s.Definition()
	if !ok || def.CanonicalUID == nil {
		return uid
	}
	return def.CanonicalUID(uid)
}

// HasFeature reports whether this server's game offers a dashboard view at
// all — distinct from an admin having switched it off, which is
// HiddenFeatures.
func (s *Server) HasFeature(feature string) bool {
	def, ok := s.Definition()
	return ok && def.HasFeature(feature)
}

// Features are the views this server's game can fill, in nav order — the menu
// the settings UI should offer for it. Falls back to every known feature for
// an unrecognised game, so the switches an admin already set stay editable.
func (s *Server) Features() []string {
	if def, ok := s.Definition(); ok {
		return def.Features
	}
	return AllFeatures()
}

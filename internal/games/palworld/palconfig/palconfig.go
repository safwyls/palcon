// Package palconfig reads and edits a Palworld server's PalWorldSettings.ini.
//
// The whole file is one INI section with a single line of the form
//
//	OptionSettings=(Difficulty=None,ExpRate=1.000000,ServerName="My Server",...)
//
// i.e. comma-separated Key=Value pairs inside one paren-wrapped value, with
// string values double-quoted. There are ~90 possible keys and no stable
// schema worth modeling, so this parses the pairs generically, classifies each
// value's type from how it's written, and — crucially — rewrites only the keys
// that changed while preserving order and everything outside OptionSettings.
//
// Writing is deliberately conservative: it never adds or removes keys, it
// validates each new value against the existing type so a bad edit can't brick
// the server's boot, it keeps a one-level .palcon.bak, and it swaps the file in
// atomically. It only ever touches the config mount; save data lives on a
// separate read-only mount.
package palconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// ErrNotConfigured is returned for servers with no config path set.
var ErrNotConfigured = errors.New("no config path configured for this server")

// Setting is one PalWorldSettings.ini option, with its value already decoded
// for display (strings unquoted, bools normalized to True/False).
type Setting struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	// Type is one of "bool", "int", "float", "string", "enum" — inferred from
	// how the value is written in the file, and what the editor renders a
	// control for.
	Type string `json:"type"`
}

var (
	intRe   = regexp.MustCompile(`^-?\d+$`)
	floatRe = regexp.MustCompile(`^-?\d+\.\d+$`)
)

// settingsFile resolves configPath to the PalWorldSettings.ini itself.
// configPath may point straight at the file, at the LinuxServer/WindowsServer
// folder that holds it, or one level up at the Config folder.
func settingsFile(configPath string) (string, error) {
	info, err := os.Stat(configPath)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return configPath, nil
	}
	for _, rel := range []string{
		"PalWorldSettings.ini",
		"LinuxServer/PalWorldSettings.ini",
		"WindowsServer/PalWorldSettings.ini",
	} {
		p := filepath.Join(configPath, rel)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("PalWorldSettings.ini not found under %s", configPath)
}

// Result is what Read returns: the settings plus where they were read from and
// whether the file is writable (a read-only mount is a common misconfiguration
// worth surfacing before the user tries to save).
type Result struct {
	Settings []Setting `json:"settings"`
	Path     string    `json:"path"`
	Writable bool      `json:"writable"`
}

// Read parses PalWorldSettings.ini under configPath.
func Read(configPath string) (*Result, error) {
	if configPath == "" {
		return nil, ErrNotConfigured
	}
	file, err := settingsFile(configPath)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	p, err := parse(string(data))
	if err != nil {
		return nil, err
	}
	settings := make([]Setting, 0, len(p.pairs))
	for _, pr := range p.pairs {
		typ, val := classify(pr.raw)
		settings = append(settings, Setting{Key: pr.key, Value: val, Type: typ})
	}
	return &Result{Settings: settings, Path: file, Writable: writable(file)}, nil
}

// Write applies changes (key -> new display value) to PalWorldSettings.ini.
// Unknown keys and values that don't fit the existing type are rejected before
// anything is written.
func Write(configPath string, changes map[string]string) error {
	if configPath == "" {
		return ErrNotConfigured
	}
	if len(changes) == 0 {
		return nil
	}
	file, err := settingsFile(configPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	p, err := parse(string(data))
	if err != nil {
		return err
	}
	index := make(map[string]int, len(p.pairs))
	for i, pr := range p.pairs {
		index[pr.key] = i
	}
	for k, v := range changes {
		i, ok := index[k]
		if !ok {
			return fmt.Errorf("unknown setting %q", k)
		}
		typ, _ := classify(p.pairs[i].raw)
		raw, err := format(typ, v)
		if err != nil {
			return fmt.Errorf("setting %s: %w", k, err)
		}
		p.pairs[i].raw = raw
	}

	var b strings.Builder
	b.WriteString(p.prefix)
	for i, pr := range p.pairs {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(pr.key)
		b.WriteByte('=')
		b.WriteString(pr.raw)
	}
	b.WriteString(p.suffix)
	return atomicWrite(file, []byte(b.String()))
}

type pair struct {
	key string
	raw string
}

type parsed struct {
	prefix string // everything up to and including the opening "OptionSettings=("
	suffix string // the closing ")" and everything after it
	pairs  []pair
}

func parse(s string) (*parsed, error) {
	ki := strings.Index(s, "OptionSettings=")
	if ki < 0 {
		return nil, errors.New("OptionSettings not found in PalWorldSettings.ini")
	}
	open := strings.IndexByte(s[ki:], '(')
	if open < 0 {
		return nil, errors.New("malformed OptionSettings: no '('")
	}
	open += ki

	depth, inQuotes, closeIdx := 0, false, -1
	for i := open; i < len(s); i++ {
		c := s[i]
		if inQuotes {
			if c == '\\' {
				i++ // skip escaped char
				continue
			}
			if c == '"' {
				inQuotes = false
			}
			continue
		}
		switch c {
		case '"':
			inQuotes = true
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				closeIdx = i
			}
		}
		if closeIdx >= 0 {
			break
		}
	}
	if closeIdx < 0 {
		return nil, errors.New("malformed OptionSettings: unbalanced parentheses")
	}

	inner := s[open+1 : closeIdx]
	var pairs []pair
	for _, ps := range splitPairs(inner) {
		ps = strings.TrimSpace(ps)
		if ps == "" {
			continue
		}
		eq := strings.IndexByte(ps, '=')
		if eq < 0 {
			return nil, fmt.Errorf("malformed setting %q", ps)
		}
		pairs = append(pairs, pair{key: ps[:eq], raw: ps[eq+1:]})
	}
	return &parsed{prefix: s[:open+1], suffix: s[closeIdx:], pairs: pairs}, nil
}

// splitPairs splits the inner OptionSettings content at top-level commas,
// leaving commas inside quoted strings or nested parens untouched.
func splitPairs(inner string) []string {
	var out []string
	var b strings.Builder
	depth, inQuotes := 0, false
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		if inQuotes {
			b.WriteByte(c)
			if c == '\\' && i+1 < len(inner) {
				i++
				b.WriteByte(inner[i])
			} else if c == '"' {
				inQuotes = false
			}
			continue
		}
		switch c {
		case '"':
			inQuotes = true
			b.WriteByte(c)
		case '(':
			depth++
			b.WriteByte(c)
		case ')':
			depth--
			b.WriteByte(c)
		case ',':
			if depth == 0 {
				out = append(out, b.String())
				b.Reset()
			} else {
				b.WriteByte(c)
			}
		default:
			b.WriteByte(c)
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

// classify infers a value's type and decodes it for display.
func classify(raw string) (typ, value string) {
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		return "string", unquote(raw)
	}
	switch strings.ToLower(raw) {
	case "true":
		return "bool", "True"
	case "false":
		return "bool", "False"
	}
	if intRe.MatchString(raw) {
		return "int", raw
	}
	if floatRe.MatchString(raw) {
		return "float", raw
	}
	return "enum", raw
}

// format re-encodes a display value into its file representation, rejecting
// anything that doesn't fit the type.
func format(typ, value string) (string, error) {
	switch typ {
	case "string":
		return quote(value), nil
	case "bool":
		switch strings.ToLower(strings.TrimSpace(value)) {
		case "true", "1", "on":
			return "True", nil
		case "false", "0", "off":
			return "False", nil
		}
		return "", fmt.Errorf("not a boolean: %q", value)
	case "int":
		v := strings.TrimSpace(value)
		if _, err := strconv.ParseInt(v, 10, 64); err == nil {
			return v, nil
		}
		// The written form is the only schema we have, and a hand-edited
		// float (ExpRate=2) classifies as int. Don't trap the key in that
		// narrower type: a float-shaped edit re-widens it to %.6f, which
		// is how the game itself writes every float.
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return strconv.FormatFloat(f, 'f', 6, 64), nil
		}
		return "", fmt.Errorf("not a number: %q", value)
	case "float":
		f, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return "", fmt.Errorf("not a number: %q", value)
		}
		// Match the game's own %.6f formatting.
		return strconv.FormatFloat(f, 'f', 6, 64), nil
	case "enum":
		v := strings.TrimSpace(value)
		if strings.ContainsAny(v, "(),\"") {
			return "", fmt.Errorf("invalid value: %q", value)
		}
		return v, nil
	}
	return "", fmt.Errorf("unknown type %q", typ)
}

func unquote(raw string) string {
	s := raw[1 : len(raw)-1]
	s = strings.ReplaceAll(s, `\"`, `"`)
	s = strings.ReplaceAll(s, `\\`, `\`)
	return s
}

func quote(val string) string {
	s := strings.ReplaceAll(val, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

// writable reports whether the file can be opened for writing, so the UI can
// warn about a read-only mount before an edit fails.
func writable(file string) bool {
	f, err := os.OpenFile(file, os.O_WRONLY, 0)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// atomicWrite replaces file's contents in one rename, after stashing the
// previous contents in a sibling .palcon.bak for one-level undo.
func atomicWrite(file string, data []byte) error {
	dir := filepath.Dir(file)
	mode := os.FileMode(0o644)
	if info, err := os.Stat(file); err == nil {
		mode = info.Mode().Perm()
		if orig, err := os.ReadFile(file); err == nil {
			_ = os.WriteFile(file+".palcon.bak", orig, mode)
		}
	}

	tmp, err := os.CreateTemp(dir, ".palconf-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return err
	}
	return os.Rename(tmpName, file)
}

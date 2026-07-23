// Package palsave reads Pal party/palbox data out of a Palworld Level.sav
// by shelling out to a bundled Python extractor built on palworld-save-tools
// (the community-standard GVAS implementation — deliberately not
// reimplemented in Go; see README "Phase 5").
//
// Read-only by design: the save file is only ever opened for reading.
package palsave

import (
	"bytes"
	"context"
	"encoding/json"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

//go:embed extract_pals.py
var extractScript []byte

// ErrNotConfigured is returned for servers with no save path set.
var ErrNotConfigured = errors.New("no save path configured for this server")

type Pal struct {
	InstanceID    string   `json:"instanceId"`
	CharacterID   string   `json:"characterId"`
	Nickname      string   `json:"nickname"`
	Level         int      `json:"level"`
	Gender        string   `json:"gender"`
	IsBoss        bool     `json:"isBoss"`
	IsLucky       bool     `json:"isLucky"`
	Rank          int      `json:"rank"`
	TalentHP      int      `json:"talentHp"`
	TalentShot    int      `json:"talentShot"`
	TalentDefense int      `json:"talentDefense"`
	Passives      []string `json:"passives"`
}

type PlayerPals struct {
	UID      string `json:"uid"`
	Nickname string `json:"nickname"`
	Level    int    `json:"level"`
	Party    []Pal  `json:"party"`
	Palbox   []Pal  `json:"palbox"`
	Base     []Pal  `json:"base"`
}

type Result struct {
	Players []PlayerPals `json:"players"`
	// ParsedAt is when the extraction ran; SaveModTime is the Level.sav
	// mtime it was parsed from — shown in the UI so "how fresh is this"
	// is never a mystery (saves only change on the game's autosave cycle).
	ParsedAt    time.Time `json:"parsedAt"`
	SaveModTime time.Time `json:"saveModTime"`
}

type cacheEntry struct {
	modTime time.Time
	result  *Result
}

// Reader runs the extractor and caches results per save path, keyed on the
// save file's mtime — a Level.sav only changes when the game autosaves, so
// re-parsing (which can take seconds on a large world) is pointless until
// the mtime moves.
type Reader struct {
	scriptPath string

	mu    sync.Mutex
	cache map[string]cacheEntry
}

// NewReader materializes the embedded extractor script into dir (the app's
// data directory) so python3 can run it.
func NewReader(dir string) (*Reader, error) {
	scriptPath := filepath.Join(dir, "extract_pals.py")
	if err := os.WriteFile(scriptPath, extractScript, 0o644); err != nil {
		return nil, fmt.Errorf("writing extractor script: %w", err)
	}
	return &Reader{scriptPath: scriptPath, cache: make(map[string]cacheEntry)}, nil
}

// savFile resolves a configured save path to the Level.sav inside it,
// accepting either the directory that holds it or the file itself.
func savFile(savePath string) (string, error) {
	info, err := os.Stat(savePath)
	if err != nil {
		return "", fmt.Errorf("save path not accessible: %w", err)
	}
	if info.IsDir() {
		return filepath.Join(savePath, "Level.sav"), nil
	}
	return savePath, nil
}

// Read returns the parsed Pal data for the given save path, re-running the
// extractor only when Level.sav's mtime has changed since the cached parse.
func (r *Reader) Read(ctx context.Context, savePath string) (*Result, error) {
	if savePath == "" {
		return nil, ErrNotConfigured
	}
	sav, err := savFile(savePath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(sav)
	if err != nil {
		return nil, fmt.Errorf("Level.sav not accessible: %w", err)
	}

	// One extraction at a time overall: parses are memory-hungry (the whole
	// decompressed world is held in Python), so serializing them protects
	// the container from concurrent-request memory spikes.
	r.mu.Lock()
	defer r.mu.Unlock()

	if entry, ok := r.cache[sav]; ok && entry.modTime.Equal(info.ModTime()) {
		return entry.result, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "python3", r.scriptPath, sav)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := stderr.String()
		if len(msg) > 500 {
			msg = msg[:500]
		}
		return nil, fmt.Errorf("extractor failed: %w: %s", err, msg)
	}

	result := &Result{ParsedAt: time.Now().UTC(), SaveModTime: info.ModTime().UTC()}
	if err := json.Unmarshal(stdout.Bytes(), result); err != nil {
		return nil, fmt.Errorf("parsing extractor output: %w", err)
	}

	r.cache[sav] = cacheEntry{modTime: info.ModTime(), result: result}
	return result, nil
}

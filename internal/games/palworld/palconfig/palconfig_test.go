package palconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A trimmed but structurally faithful PalWorldSettings.ini: the section
// header, then one OptionSettings line mixing enums, floats, ints, bools and
// quoted strings — including a server name with an internal comma to exercise
// quote-aware splitting.
const fixture = `[/Script/Pal.PalGameWorldSettings]
OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,ExpRate=1.000000,PalCaptureRate=1.000000,DeathPenalty=All,bEnablePlayerToPlayerDamage=False,DropItemMaxNum=3000,ServerName="Sam's Server, EU",ServerDescription="",AdminPassword="hunter2",PublicPort=8211,RESTAPIEnabled=True)
`

func writeFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "PalWorldSettings.ini")
	if err := os.WriteFile(file, []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func settingsMap(t *testing.T, dir string) map[string]Setting {
	t.Helper()
	res, err := Read(dir)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	m := make(map[string]Setting, len(res.Settings))
	for _, s := range res.Settings {
		m[s.Key] = s
	}
	return m
}

func TestReadClassifies(t *testing.T) {
	m := settingsMap(t, writeFixture(t))
	cases := []struct {
		key, typ, val string
	}{
		{"Difficulty", "enum", "None"},
		{"DayTimeSpeedRate", "float", "1.000000"},
		{"DropItemMaxNum", "int", "3000"},
		{"bEnablePlayerToPlayerDamage", "bool", "False"},
		{"ServerName", "string", "Sam's Server, EU"}, // comma inside quotes preserved
		{"ServerDescription", "string", ""},
		{"AdminPassword", "string", "hunter2"},
		{"RESTAPIEnabled", "bool", "True"},
	}
	for _, c := range cases {
		got, ok := m[c.key]
		if !ok {
			t.Errorf("%s: missing", c.key)
			continue
		}
		if got.Type != c.typ || got.Value != c.val {
			t.Errorf("%s: got {%s %q}, want {%s %q}", c.key, got.Type, got.Value, c.typ, c.val)
		}
	}
	if len(m) != 12 {
		t.Errorf("expected 12 settings, got %d", len(m))
	}
}

func TestWriteRoundTrip(t *testing.T) {
	dir := writeFixture(t)
	changes := map[string]string{
		"ExpRate":                     "2.5",             // float reformatted to %.6f
		"bEnablePlayerToPlayerDamage": "true",            // bool normalized
		"DropItemMaxNum":              "5000",            // int
		"ServerName":                  "New, Name \"X\"", // string re-quoted+escaped
	}
	if err := Write(dir, changes); err != nil {
		t.Fatalf("Write: %v", err)
	}

	raw, _ := os.ReadFile(filepath.Join(dir, "PalWorldSettings.ini"))
	out := string(raw)

	// The header and unrelated keys survive untouched, order preserved.
	if !strings.HasPrefix(out, "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,ExpRate=2.500000,") {
		t.Errorf("prefix/order not preserved:\n%s", out)
	}
	for want := range map[string]bool{
		"ExpRate=2.500000":                 true,
		"bEnablePlayerToPlayerDamage=True": true,
		"DropItemMaxNum=5000":              true,
		`ServerName="New, Name \"X\""`:     true,
		"PalCaptureRate=1.000000":          true, // untouched
		`AdminPassword="hunter2"`:          true, // untouched
	} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in output:\n%s", want, out)
		}
	}

	// Re-reading yields the decoded values.
	m := settingsMap(t, dir)
	if m["ServerName"].Value != `New, Name "X"` {
		t.Errorf("ServerName round-trip: got %q", m["ServerName"].Value)
	}
	if m["ExpRate"].Value != "2.500000" {
		t.Errorf("ExpRate round-trip: got %q", m["ExpRate"].Value)
	}

	// A one-level backup of the original is kept.
	if _, err := os.Stat(filepath.Join(dir, "PalWorldSettings.ini.palcon.bak")); err != nil {
		t.Errorf("expected .palcon.bak: %v", err)
	}
}

func TestWriteRejectsBadInput(t *testing.T) {
	for name, changes := range map[string]map[string]string{
		"unknown key": {"NopeNotAKey": "1"},
		"bad int":     {"DropItemMaxNum": "lots"},
		"bad float":   {"ExpRate": "fast"},
		"bad bool":    {"RESTAPIEnabled": "maybe"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := writeFixture(t)
			before, _ := os.ReadFile(filepath.Join(dir, "PalWorldSettings.ini"))
			if err := Write(dir, changes); err == nil {
				t.Fatal("expected error, got nil")
			}
			after, _ := os.ReadFile(filepath.Join(dir, "PalWorldSettings.ini"))
			if string(before) != string(after) {
				t.Error("file changed despite validation error")
			}
		})
	}
}

// A hand-edited float like ExpRate=2 classifies as int; the editor must
// still accept a float for it (re-widening to %.6f) rather than trapping
// the key as an integer forever. Values that are ints stay int-formatted.
func TestIntClassifiedKeyAcceptsFloat(t *testing.T) {
	dir := t.TempDir()
	handEdited := "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(ExpRate=2,DropItemMaxNum=3000)\n"
	file := filepath.Join(dir, "PalWorldSettings.ini")
	if err := os.WriteFile(file, []byte(handEdited), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := Write(dir, map[string]string{"ExpRate": "2.5", "DropItemMaxNum": "5000"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, _ := os.ReadFile(file)
	if !strings.Contains(string(raw), "ExpRate=2.500000") {
		t.Errorf("ExpRate not re-widened to a float: %s", raw)
	}
	if !strings.Contains(string(raw), "DropItemMaxNum=5000") {
		t.Errorf("integer value should stay int-formatted: %s", raw)
	}
}

func TestReadNotConfigured(t *testing.T) {
	if _, err := Read(""); err != ErrNotConfigured {
		t.Errorf("got %v, want ErrNotConfigured", err)
	}
}

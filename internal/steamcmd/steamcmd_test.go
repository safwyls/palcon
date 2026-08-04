package steamcmd

import (
	"strings"
	"testing"
)

// SteamCMD is exec'd without a shell: every token must be its own argv
// element, and validate must follow the app id.
func TestUpdateArgs(t *testing.T) {
	got := strings.Join(UpdateArgs("/palworld", 2394010, true), " ")
	want := "+force_install_dir /palworld +login anonymous +app_update 2394010 validate +quit"
	if got != want {
		t.Errorf("with validate:\n got %q\nwant %q", got, want)
	}
	for _, arg := range UpdateArgs("/palworld", 2394010, false) {
		if strings.Contains(arg, " ") {
			t.Errorf("argv element %q contains a space — would break exec without a shell", arg)
		}
	}
}

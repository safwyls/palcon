package palworld

import "testing"

// The two transports spell the same player two different ways, and both have
// to land on the save's spelling — a mismatch here doesn't error, it just
// silently matches nothing.
func TestCanonicalUID(t *testing.T) {
	const save = "3e3abc0e-0000-0000-0000-000000000000"

	for _, tc := range []struct {
		name, in, want string
	}{
		{"rest hex, undashed", "3E3ABC0E000000000000000000000000", save},
		{"rcon decimal word", "1044036622", save},
		{"already canonical", save, save},
		{"dashed uppercase", "3E3ABC0E-0000-0000-0000-000000000000", save},
		{"bare hex word", "3e3abc0e", save},
		{"empty", "", ""},
		// Nothing recognisable: lowercased and left alone, so a caller
		// matching on it finds nothing rather than the wrong player.
		{"unrecognised", "not-a-uid", "not-a-uid"},
	} {
		if got := CanonicalUID(tc.in); got != tc.want {
			t.Errorf("%s: CanonicalUID(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

// A guid body that happens to be all digits is still hex — reading it as
// decimal would rewrite a valid uid into a different player's.
func TestCanonicalUIDKeepsAllDigitFullGuid(t *testing.T) {
	const in = "10440366220000000000000000000000"
	want := "10440366-2200-0000-0000-000000000000"
	if got := CanonicalUID(in); got != want {
		t.Errorf("CanonicalUID(%q) = %q, want %q", in, got, want)
	}
}

package palworld

import (
	"strconv"
	"strings"
)

// CanonicalUID renders a live player id in the dashed form the save files use,
// so an id from either transport can be compared against a save's PlayerUId.
//
// The transports disagree about how to spell the same uid: REST returns the
// guid as undashed hex, RCON returns only its leading word and as a decimal
// integer, and a save writes it dashed. A raw comparison therefore never
// matches — which is why this lives somewhere both the API and the collector
// can reach rather than being redone per caller.
//
// Anything unrecognisable comes back lowercased and otherwise untouched: a
// caller matching on it then finds nothing, which is the safe result for both
// a visibility check and a last-seen lookup.
func CanonicalUID(uid string) string {
	h := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(uid), "-", ""))
	if h == "" {
		return ""
	}
	if isDecimalWord(h) {
		n, err := strconv.ParseUint(h, 10, 32)
		if err != nil {
			return strings.ToLower(uid)
		}
		h = strconv.FormatUint(n, 16)
	}
	// A bare leading word rebuilds into the full guid: left-pad it so its hex
	// digits land in the right columns, then append the 24 zeros Palworld
	// leaves in the rest.
	if len(h) <= 8 && isHex(h) {
		h = strings.Repeat("0", 8-len(h)) + h + strings.Repeat("0", 24)
	}
	if len(h) != 32 || !isHex(h) {
		return strings.ToLower(uid)
	}
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// isDecimalWord reports whether s should be read as RCON's decimal spelling.
//
// All-digit strings are ambiguous — "1044036622" is valid hex and valid
// decimal — so length breaks the tie: a full 32-digit body is already a guid
// and reading it as decimal would rewrite it into a different player's uid,
// while anything shorter is RCON's leading word.
func isDecimalWord(s string) bool {
	if len(s) >= 32 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func isHex(s string) bool {
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

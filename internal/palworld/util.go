package palworld

import "strconv"

func addr(host string, port int) string {
	return host + ":" + strconv.Itoa(port)
}

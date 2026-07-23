package api

import (
	"io/fs"
	"net/http"
)

// spaHandler serves static assets from staticFS, falling back to
// index.html for any path that doesn't match a file so client-side
// routes (e.g. /servers/3) work on a hard refresh.
func spaHandler(staticFS fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(staticFS))
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path != "/" {
			if f, err := staticFS.Open(path[1:]); err == nil {
				f.Close()
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	}
}

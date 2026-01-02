//go:build !embedfront

package api

import (
	"io/fs"
	"os"
)

func loadStaticFS() (fs.FS, string, error) {
	dir := resolveStaticDir()
	statErr := error(nil)
	if _, err := os.Stat(dir); err != nil {
		statErr = err
	}
	return os.DirFS(dir), dir, statErr
}

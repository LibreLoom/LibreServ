//go:build embedfront

package api

import (
	"io/fs"

	osdist "gt.plainskill.net/LibreLoom/LibreServ/OS"
)

func loadStaticFS() (fs.FS, string, error) {
	sub, err := fs.Sub(osdist.FS, "dist")
	if err != nil {
		return nil, "embed", err
	}
	return sub, "embed", nil
}

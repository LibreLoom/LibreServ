package api

import (
	"embed"
	"io/fs"
	"log/slog"
)

//go:embed all:admin/dist
var embeddedAdmin embed.FS

//go:embed all:customer/dist
var embeddedCustomer embed.FS

func mustSubFS(efs embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(efs, dir)
	if err != nil {
		slog.Error("failed to create sub filesystem", "dir", dir, "error", err)
		panic(err)
	}
	return sub
}

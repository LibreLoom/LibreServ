//go:build embedfront

package osdist

import "embed"

// FS contains the built frontend assets.
//
//go:embed dist
var FS embed.FS

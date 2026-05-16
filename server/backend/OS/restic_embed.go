//go:build embedrestic

package osdist

import _ "embed"

// ResticBinary holds the embedded restic binary when compiled with the embedrestic tag.
//
//go:embed bin/restic
var ResticBinary []byte

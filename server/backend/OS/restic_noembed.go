//go:build !embedrestic

package osdist

// ResticBinary is nil when compiled without the embedrestic tag.
var ResticBinary []byte

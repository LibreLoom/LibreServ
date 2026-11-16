package tests

import "testing"

// The lunad suite makes and deletes gigabytes of temp files. In a container
// /tmp is a disk overlay, so without a tmpfs the Rust step took ~450s instead
// of ~46s. Both Luna steps that run it must keep /tmp in RAM.
func TestLunaRustStepsKeepTmpInRAM(t *testing.T) {
	for _, id := range []string{"luna-ci", "luna-fast"} {
		found := DefaultRegistry.GetByIDs([]string{id})
		if len(found) != 1 {
			t.Fatalf("%s is not registered", id)
		}
		test := found[0]
		if test.Tmpfs["/tmp"] == "" {
			t.Errorf("%s must mount /tmp as tmpfs; the container's disk-backed /tmp makes the lunad tests ~10x slower", id)
		}
	}
}

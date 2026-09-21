package util

import "testing"

func TestSafeDiskBytes(t *testing.T) {
	tests := []struct {
		name   string
		blocks int64
		bsize  int64
		want   uint64
	}{
		{"normal", 100, 4096, 409600},
		{"zero blocks", 0, 4096, 0},
		{"negative blocks", -1, 4096, 0},
		{"zero bsize", 100, 0, 0},
		{"negative bsize", 100, -1, 0},
		{"large values", 1 << 30, 4096, uint64(1<<30) * 4096},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := SafeDiskBytes(tt.blocks, tt.bsize); got != tt.want {
				t.Errorf("SafeDiskBytes(%d, %d) = %d, want %d", tt.blocks, tt.bsize, got, tt.want)
			}
		})
	}
}

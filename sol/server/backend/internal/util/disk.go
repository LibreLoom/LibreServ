package util

func SafeDiskBytes(blocks, bsize int64) uint64 {
	if blocks < 0 || bsize <= 0 {
		return 0
	}
	return uint64(blocks) * uint64(bsize)
}

package store

// StorageSlot is the store slot holding one Luna's cloud storage blobs.
func StorageSlot(lunaID string) string {
	return "storage-" + lunaID
}

// StoragePackPath is the blob path of a content-addressed pack.
func StoragePackPath(id string) string {
	return "packs/" + id
}

// StorageRecordPath is the blob path of a named record.
func StorageRecordPath(kind, name string) string {
	return "records/" + kind + "/" + name
}

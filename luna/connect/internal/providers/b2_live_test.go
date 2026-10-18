package providers

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"io"
	"os"
	"testing"
)

// TestB2Live runs the bucket lifecycle against real Backblaze B2. It is skipped unless a key is
// given, and it only touches a bucket and keys it creates itself, then removes them:
//
//	LUNACONNECT_B2_LIVE_ID=<key id> LUNACONNECT_B2_LIVE_KEY=<application key> \
//	  go test ./internal/providers -run TestB2Live -v
//
// The key needs the capabilities Connect uses: bucket, key and file management.
func TestB2Live(t *testing.T) {
	id, key := os.Getenv("LUNACONNECT_B2_LIVE_ID"), os.Getenv("LUNACONNECT_B2_LIVE_KEY")
	if id == "" || key == "" {
		t.Skip("set LUNACONNECT_B2_LIVE_ID and LUNACONNECT_B2_LIVE_KEY to run against real B2")
	}
	c := NewB2Client(nil)
	name := bucketName("luna-live", BucketKey("acct_livetest", "storage-"+randomHex(8)))

	creds, err := c.ProvisionBucket(id, key, name)
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	cleaned := false
	cleanup := func() {
		if cleaned {
			return
		}
		cleaned = true
		if err := c.DeleteBucket(id, key, creds.BucketID); err != nil {
			t.Errorf("delete bucket: %v", err)
		}
		if err := c.DeleteKey(id, key, creds.KeyID); err != nil {
			t.Errorf("delete key: %v", err)
		}
	}
	t.Cleanup(cleanup)

	body := []byte("live b2 round trip")
	sum := sha1.Sum(body)
	obj := "acct_livetest/storage-x/packs/test"
	if err := c.UploadFile(creds.KeyID, creds.Key, creds.BucketID, obj, bytes.NewReader(body), int64(len(body)), hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("upload: %v", err)
	}
	rc, err := c.DownloadFile(creds.KeyID, creds.Key, creds.BucketName, obj)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, body) {
		t.Fatalf("downloaded %q", got)
	}

	// A bucket that still holds a file must refuse deletion, and delete once emptied.
	if err := c.DeleteBucket(id, key, creds.BucketID); err == nil {
		t.Fatal("deleting a non-empty bucket should fail")
	}
	if err := c.DeleteFile(creds.KeyID, creds.Key, creds.BucketID, obj); err != nil {
		t.Fatalf("delete file: %v", err)
	}
	cleanup()
}

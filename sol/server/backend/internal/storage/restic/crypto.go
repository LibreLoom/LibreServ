package restic

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

func DeriveRepoPassword(serverSecret, appID string) string {
	mac := hmac.New(sha256.New, []byte(serverSecret))
	mac.Write([]byte("libreserv-backup-repo-key"))
	mac.Write([]byte(appID))
	return hex.EncodeToString(mac.Sum(nil))
}

func ValidateRepoType(repoType string) error {
	switch repoType {
	case "local", "s3", "b2", "sftp":
		return nil
	default:
		return fmt.Errorf("unsupported repository type: %q", repoType)
	}
}

func BuildRepoPath(repoType, basePath, appID string) string {
	switch repoType {
	case "local":
		return fmt.Sprintf("%s/repos/%s", basePath, appID)
	case "b2":
		return fmt.Sprintf("b2:%s", appID)
	case "s3":
		return fmt.Sprintf("s3:%s", appID)
	case "sftp":
		return fmt.Sprintf("sftp:%s", appID)
	default:
		return ""
	}
}

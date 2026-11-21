package providers

// B2AuthorizeBodyForTest is a v3 b2_authorize_account answer for fake B2 servers in tests.
// Empty URLs are left out, as B2 would leave them null. For tests only.
func B2AuthorizeBodyForTest(accountID, token, apiURL, downloadURL, s3APIURL string) map[string]any {
	storage := map[string]any{
		"infoType":                "storageApi",
		"recommendedPartSize":     100000000,
		"absoluteMinimumPartSize": 5000000,
		"bucketId":                nil,
		"bucketName":              nil,
		"namePrefix":              nil,
		"capabilities":            []string{"listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"},
	}
	for k, v := range map[string]string{"apiUrl": apiURL, "downloadUrl": downloadURL, "s3ApiUrl": s3APIURL} {
		if v != "" {
			storage[k] = v
		}
	}
	return map[string]any{
		"accountId":                         accountID,
		"authorizationToken":                token,
		"applicationKeyExpirationTimestamp": nil,
		"apiInfo":                           map[string]any{"storageApi": storage},
	}
}

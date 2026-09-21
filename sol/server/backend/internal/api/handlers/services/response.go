package services

import "gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"

// JSON and JSONError are aliases to the canonical helpers in internal/api/response
// to avoid duplication. Deprecated: import response directly.
var (
	JSON      = response.JSON
	JSONError = response.JSONError
)

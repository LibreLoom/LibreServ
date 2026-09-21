package handlers

import (
	"encoding/json"
	"net/http"
)

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func JSONError(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message, "message": message})
}

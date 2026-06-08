package bluetooth

import (
	"net/http"
	"sync"
)

var (
	Router   http.Handler
	RouterMu sync.RWMutex
)

func SetRouter(h http.Handler) {
	RouterMu.Lock()
	defer RouterMu.Unlock()
	Router = h
}

func getRouter() http.Handler {
	RouterMu.RLock()
	defer RouterMu.RUnlock()
	return Router
}

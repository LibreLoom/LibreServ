package main

import (
	"log"
	"net/http"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("atlas-bot ")
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	s := newServer(cfg)
	log.Printf("listening on %s (runtime=%s image=%s)", cfg.Listen, cfg.Runtime, cfg.DSHImage)
	if err := http.ListenAndServe(cfg.Listen, s.routes()); err != nil {
		log.Fatal(err)
	}
}

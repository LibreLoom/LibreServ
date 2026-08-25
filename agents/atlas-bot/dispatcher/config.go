package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	defaultBotUser    = "atlas-bot"
	defaultOwnersOrg  = "LibreLoom"
	defaultOwnersTeam = "owners"
	defaultCooking    = "**Cooking...**"
	notOwnersMessage = "Sorry \u2014 only members of the LibreLoom **Owners** team can invoke @atlas-bot."
	maxCommentBytes  = 60000
	ownersCacheTTL   = 15 * time.Second
)

type config struct {
	Listen          string
	ForgejoBase     string
	ForgejoInternal string
	Token           string
	WebhookSecret   string
	AIProxyKey      string
	BotUser         string
	OwnersOrg       string
	OwnersTeam      string
	Cooking         string
	Runtime         string
	DSHImage        string
	JobTimeout      time.Duration
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func loadConfig() (config, error) {
	c := config{
		Listen:          envOr("LISTEN_ADDR", ":8080"),
		ForgejoBase:     strings.TrimRight(envOr("FORGEJO_BASE", "https://gt.plainskill.net"), "/"),
		ForgejoInternal: strings.TrimRight(os.Getenv("FORGEJO_INTERNAL_URL"), "/"),
		Token:           os.Getenv("FORGEJO_TOKEN"),
		WebhookSecret:   os.Getenv("WEBHOOK_SECRET"),
		AIProxyKey:      os.Getenv("AI_PROXY_API_KEY"),
		BotUser:         envOr("ATLAS_BOT_USER", defaultBotUser),
		OwnersOrg:       envOr("OWNERS_ORG", defaultOwnersOrg),
		OwnersTeam:      envOr("OWNERS_TEAM", defaultOwnersTeam),
		Cooking:         envOr("COOKING_TEXT", defaultCooking),
		Runtime:         envOr("CONTAINER_RUNTIME", "podman"),
		DSHImage:        envOr("DSH_IMAGE", "localhost/atlas-bot-dsh:latest"),
		JobTimeout:      20 * time.Minute,
	}
	if c.ForgejoInternal == "" {
		c.ForgejoInternal = c.ForgejoBase
	}
	if sec := os.Getenv("JOB_TIMEOUT"); sec != "" {
		d, err := time.ParseDuration(sec)
		if err != nil {
			return c, fmt.Errorf("JOB_TIMEOUT: %w", err)
		}
		c.JobTimeout = d
	}
	if c.Token == "" {
		return c, errors.New("FORGEJO_TOKEN is required")
	}
	if c.WebhookSecret == "" {
		return c, errors.New("WEBHOOK_SECRET is required")
	}
	return c, nil
}

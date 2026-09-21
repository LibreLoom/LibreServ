// Package handlers groups the HTTP endpoint handlers by domain:
//
//	auth/     login, sessions, MFA, OIDC, API tokens, CSRF, invites, users, profile
//	apps/     app lifecycle, catalog, repos, scripts, logs, job queue, agent chat
//	network/  routes, ACME, DNS/DDNS, domains, connectivity, mappings, wifi, tunnel
//	backups/  backup runs and schedules
//	services/ external cloud services (Connect, plans)
//	system/   health, monitoring, settings, setup, audit, security events
//	shared/   request/session helpers shared across domains
package handlers

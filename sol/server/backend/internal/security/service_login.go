package security

import (
	"fmt"
	"net"
	"strings"
	"time"
)

func (s *Service) countRecentAttempts(window *attemptWindow, since time.Time) int {
	count := 0
	for _, attempt := range window.attempts {
		if attempt.After(since) {
			count++
		}
	}
	return count
}

func (s *Service) addAttempt(window *attemptWindow, now time.Time) {
	// Remove old attempts beyond MaxAttemptsPerWindow
	if len(window.attempts) >= s.config.MaxAttemptsPerWindow {
		// Keep only the most recent attempts
		window.attempts = window.attempts[len(window.attempts)-s.config.MaxAttemptsPerWindow+1:]
	}

	window.attempts = append(window.attempts, now)
	window.lastAttempt = now
}

func (s *Service) RecordFailedLogin(username, ipAddress, userAgent, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	windowStart := now.Add(-s.config.BruteForceWindow)

	// Track by IP
	if ipAddress != "" {
		ipWindow, exists := s.failedAttempts[ipAddress]
		if !exists {
			ipWindow = &attemptWindow{}
			s.failedAttempts[ipAddress] = ipWindow
		}

		s.addAttempt(ipWindow, now)

		// Check if we should lock
		recentAttempts := s.countRecentAttempts(ipWindow, windowStart)
		if recentAttempts >= s.config.BruteForceThreshold {
			ipWindow.lockedUntil = now.Add(s.config.LockoutDuration)
			s.metrics.AccountsLocked++
			s.logger.Warn("IP address locked due to failed login attempts",
				"ip", s.anonymizeIP(ipAddress),
				"attempts", recentAttempts,
				"lockedUntil", ipWindow.lockedUntil,
			)
		}
	}

	// Track by username
	if username != "" {
		userWindow, exists := s.userFailedLogins[username]
		if !exists {
			userWindow = &attemptWindow{}
			s.userFailedLogins[username] = userWindow
		}

		s.addAttempt(userWindow, now)

		// Check if we should lock
		recentAttempts := s.countRecentAttempts(userWindow, windowStart)
		if recentAttempts >= s.config.BruteForceThreshold {
			userWindow.lockedUntil = now.Add(s.config.LockoutDuration)
			s.metrics.AccountsLocked++
			s.logger.Warn("User account locked due to failed login attempts",
				"username", username,
				"attempts", recentAttempts,
				"lockedUntil", userWindow.lockedUntil,
			)
		}
	}

	s.metrics.FailedLoginsTracked++

	return nil
}

func (s *Service) IsLockedOut(ipAddress, username string) (bool, time.Time) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now()

	// Check IP lock
	if ipAddress != "" {
		if window, exists := s.failedAttempts[ipAddress]; exists {
			if now.Before(window.lockedUntil) {
				return true, window.lockedUntil
			}
		}
	}

	// Check user lock
	if username != "" {
		if window, exists := s.userFailedLogins[username]; exists {
			if now.Before(window.lockedUntil) {
				return true, window.lockedUntil
			}
		}
	}

	return false, time.Time{}
}

func (s *Service) ClearFailedAttempts(ipAddress, username string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if ipAddress != "" {
		delete(s.failedAttempts, ipAddress)
	}

	if username != "" {
		delete(s.userFailedLogins, username)
	}
}

func (s *Service) anonymizeIP(ip string) string {
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return ip
	}

	if parsedIP.To4() != nil {
		// IPv4 - mask last octet
		parts := strings.Split(ip, ".")
		if len(parts) == 4 {
			return fmt.Sprintf("%s.%s.%s.xxx", parts[0], parts[1], parts[2])
		}
	} else {
		// IPv6 - mask last 64 bits
		parts := strings.Split(ip, ":")
		if len(parts) >= 4 {
			return strings.Join(parts[:4], ":") + ":xxxx:xxxx:xxxx:xxxx"
		}
	}

	return ip
}

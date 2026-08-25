package main

import "strings"

func isIdentChar(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_' || b == '-'
}

func mentioned(s string) bool {
	lower := strings.ToLower(s)
	n := "@atlas-bot"
	idx := 0
	for {
		i := strings.Index(lower[idx:], n)
		if i < 0 {
			return false
		}
		i += idx
		leftOK := i == 0 || !isIdentChar(lower[i-1])
		end := i + len(n)
		rightOK := end == len(lower) || !isIdentChar(lower[end])
		if leftOK && rightOK {
			return true
		}
		idx = i + 1
		if idx >= len(lower) {
			return false
		}
	}
}

func instructionFrom(body string) string {
	body = strings.TrimSpace(body)
	lower := strings.ToLower(body)
	out := body
	for {
		i := strings.Index(strings.ToLower(out), "@atlas-bot")
		if i < 0 {
			break
		}
		end := i + len("@atlas-bot")
		out = strings.TrimSpace(out[:i] + out[end:])
		_ = lower
	}
	if strings.TrimSpace(out) == "" {
		return body
	}
	return strings.TrimSpace(out)
}

func isAssignedTo(bot string, assignee *userRef, assignees []userRef) bool {
	if assignee != nil && strings.EqualFold(assignee.name(), bot) {
		return true
	}
	for _, a := range assignees {
		if strings.EqualFold(a.name(), bot) {
			return true
		}
	}
	return false
}

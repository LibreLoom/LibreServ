package main

import "strings"

func eventName(headers map[string][]string) string {
	get := func(k string) string {
		if v := headers[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	if v := get("X-Forgejo-Event"); v != "" {
		return v
	}
	if v := get("X-Gitea-Event"); v != "" {
		return v
	}
	return get("X-Github-Event")
}

func (s *server) extractJob(event string, p hookPayload) (job, bool) {
	sender := p.Sender.name()
	if strings.EqualFold(sender, s.cfg.BotUser) {
		return job{}, false
	}
	owner := p.Repository.Owner.name()
	repo := p.Repository.Name
	if owner == "" || repo == "" {
		return job{}, false
	}

	switch event {
	case "issue_comment", "pull_request_comment":
		if p.Comment == nil || p.Issue == nil {
			return job{}, false
		}
		if p.Action != "" && p.Action != "created" {
			return job{}, false
		}
		if strings.TrimSpace(p.Comment.Body) == s.cfg.Cooking {
			return job{}, false
		}
		if !mentioned(p.Comment.Body) {
			return job{}, false
		}
		return job{
			Owner:       owner,
			Repo:        repo,
			Number:      p.Issue.Number,
			IsPull:      p.Issue.isPull() || event == "pull_request_comment",
			Instruction: instructionFrom(p.Comment.Body),
			Sender:      sender,
			CommentID:   p.Comment.ID,
		}, true

	case "issues", "issue_assign":
		if p.Issue == nil {
			return job{}, false
		}
		switch p.Action {
		case "assigned":
			if !isAssignedTo(s.cfg.BotUser, p.Assignee, p.Issue.Assignees) {
				return job{}, false
			}
			instr := strings.TrimSpace(p.Issue.Body)
			if instr == "" {
				instr = p.Issue.Title
			}
			return job{Owner: owner, Repo: repo, Number: p.Issue.Number, IsPull: p.Issue.isPull(), Instruction: instr, Sender: sender}, true
		case "opened", "reopened":
			if !mentioned(p.Issue.Body) && !mentioned(p.Issue.Title) {
				return job{}, false
			}
			return job{Owner: owner, Repo: repo, Number: p.Issue.Number, IsPull: p.Issue.isPull(), Instruction: instructionFrom(p.Issue.Title + "\n\n" + p.Issue.Body), Sender: sender}, true
		default:
			return job{}, false
		}

	case "pull_request", "pull_request_assign":
		pr := p.PullRequest
		if pr == nil && p.Issue != nil {
			pr = &prRef{Number: p.Issue.Number, Title: p.Issue.Title, Body: p.Issue.Body, Assignees: p.Issue.Assignees}
		}
		if pr == nil {
			return job{}, false
		}
		switch p.Action {
		case "assigned":
			if !isAssignedTo(s.cfg.BotUser, p.Assignee, pr.Assignees) {
				return job{}, false
			}
			instr := strings.TrimSpace(pr.Body)
			if instr == "" {
				instr = pr.Title
			}
			return job{Owner: owner, Repo: repo, Number: pr.Number, IsPull: true, Instruction: instr, Sender: sender}, true
		case "opened", "reopened":
			if !mentioned(pr.Body) && !mentioned(pr.Title) {
				return job{}, false
			}
			return job{Owner: owner, Repo: repo, Number: pr.Number, IsPull: true, Instruction: instructionFrom(pr.Title + "\n\n" + pr.Body), Sender: sender}, true
		default:
			return job{}, false
		}
	default:
		return job{}, false
	}
}

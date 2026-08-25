package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n...(truncated)"
}

func (s *server) apiURL(p string) string {
	return s.cfg.ForgejoInternal + "/api/v1" + p
}

func (s *server) doJSON(ctx context.Context, method, p string, body any, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.apiURL(p), rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "token "+s.cfg.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	slurp, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %s %s", method, p, resp.Status, trim(string(slurp), 500))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(slurp, out)
}

func (s *server) senderIsOwner(ctx context.Context, login string) (bool, error) {
	login = strings.ToLower(login)
	s.ownersMu.Lock()
	if s.owners != nil && time.Since(s.ownersAt) < ownersCacheTTL {
		_, ok := s.owners[login]
		s.ownersMu.Unlock()
		return ok, nil
	}
	s.ownersMu.Unlock()

	members := map[string]struct{}{}
	page := 1
	for {
		var users []userRef
		path := fmt.Sprintf("/orgs/%s/teams/%s/members?page=%d&limit=50", s.cfg.OwnersOrg, s.cfg.OwnersTeam, page)
		if err := s.doJSON(ctx, http.MethodGet, path, nil, &users); err != nil {
			return false, err
		}
		if len(users) == 0 {
			break
		}
		for _, u := range users {
			members[strings.ToLower(u.name())] = struct{}{}
		}
		if len(users) < 50 {
			break
		}
		page++
		if page > 20 {
			break
		}
	}
	s.ownersMu.Lock()
	s.owners = members
	s.ownersAt = time.Now()
	_, ok := members[login]
	s.ownersMu.Unlock()
	return ok, nil
}

func (s *server) postComment(ctx context.Context, job job, body string) error {
	p := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", job.Owner, job.Repo, job.Number)
	return s.doJSON(ctx, http.MethodPost, p, map[string]string{"body": body}, nil)
}

func (s *server) getIssue(ctx context.Context, owner, repo string, number int) (issueRef, error) {
	var issue issueRef
	err := s.doJSON(ctx, http.MethodGet, fmt.Sprintf("/repos/%s/%s/issues/%d", owner, repo, number), nil, &issue)
	return issue, err
}

func (s *server) getComments(ctx context.Context, job job) ([]commentRef, error) {
	var all []commentRef
	page := 1
	for {
		var batch []commentRef
		p := fmt.Sprintf("/repos/%s/%s/issues/%d/comments?page=%d&limit=50", job.Owner, job.Repo, job.Number, page)
		if err := s.doJSON(ctx, http.MethodGet, p, nil, &batch); err != nil {
			return all, err
		}
		all = append(all, batch...)
		if len(batch) < 50 {
			break
		}
		page++
		if page > 20 {
			break
		}
	}
	return all, nil
}

func (s *server) getDiff(ctx context.Context, job job) (string, error) {
	if !job.IsPull {
		return "", nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.apiURL(fmt.Sprintf("/repos/%s/%s/pulls/%d.diff", job.Owner, job.Repo, job.Number)), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "token "+s.cfg.Token)
	resp, err := s.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("diff: %s", resp.Status)
	}
	return string(b), nil
}

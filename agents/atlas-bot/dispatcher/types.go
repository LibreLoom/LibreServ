package main

import (
	"bytes"
	"encoding/json"
)

type userRef struct {
	Login    string `json:"login"`
	Username string `json:"username"`
}

func (u userRef) name() string {
	if u.Login != "" {
		return u.Login
	}
	return u.Username
}

type commentRef struct {
	ID   int64  `json:"id"`
	Body string `json:"body"`
}

type labelRef struct {
	Name string `json:"name"`
}

type issueRef struct {
	Number      int             `json:"number"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	State       string          `json:"state"`
	PullRequest json.RawMessage `json:"pull_request"`
	Assignees   []userRef       `json:"assignees"`
	Labels      []labelRef      `json:"labels"`
}

func (i issueRef) isPull() bool {
	return len(bytes.TrimSpace(i.PullRequest)) > 0 && string(i.PullRequest) != "null"
}

type prRef struct {
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	State     string     `json:"state"`
	Assignees []userRef  `json:"assignees"`
	Labels    []labelRef `json:"labels"`
}

type repoRef struct {
	Name     string  `json:"name"`
	FullName string  `json:"full_name"`
	Owner    userRef `json:"owner"`
}

type hookPayload struct {
	Action      string      `json:"action"`
	Sender      userRef     `json:"sender"`
	Comment     *commentRef `json:"comment"`
	Issue       *issueRef   `json:"issue"`
	PullRequest *prRef      `json:"pull_request"`
	Assignee    *userRef    `json:"assignee"`
	Repository  repoRef     `json:"repository"`
}

type job struct {
	Owner       string
	Repo        string
	Number      int
	IsPull      bool
	Instruction string
	Sender      string
	CommentID   int64
}

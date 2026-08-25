package main

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

func linkedIndexes(title, body string, comments []commentRef) []int {
	hay := title + "\n" + body
	for _, c := range comments {
		hay += "\n" + c.Body
	}
	seen := map[int]struct{}{}
	var out []int
	for i := 0; i < len(hay); i++ {
		if hay[i] != '#' {
			continue
		}
		j := i + 1
		n := 0
		for j < len(hay) && hay[j] >= '0' && hay[j] <= '9' {
			n = n*10 + int(hay[j]-'0')
			j++
		}
		if n == 0 || j == i+1 {
			continue
		}
		if _, ok := seen[n]; ok {
			continue
		}
		seen[n] = struct{}{}
		out = append(out, n)
	}
	return out
}

func (s *server) stageFile(ctx context.Context, runtime, vol, rel, content string) error {
	cmd := exec.CommandContext(ctx, runtime, "run", "--rm",
		"-v", vol+":/work",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges:true",
		"busybox:1.36",
		"sh", "-c", "mkdir -p /work/context && cat > /work/"+rel,
	)
	cmd.Stdin = strings.NewReader(content)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("stage %s: %s %w", rel, out, err)
	}
	return nil
}

func (s *server) runSandbox(ctx context.Context, job job) (string, error) {
	issue, err := s.getIssue(ctx, job.Owner, job.Repo, job.Number)
	if err != nil {
		return "", fmt.Errorf("issue: %w", err)
	}
	if issue.isPull() {
		job.IsPull = true
	}
	comments, err := s.getComments(ctx, job)
	if err != nil {
		return "", fmt.Errorf("comments: %w", err)
	}
	diff, _ := s.getDiff(ctx, job)

	var issueMD strings.Builder
	fmt.Fprintf(&issueMD, "# %s\n\nNumber: %d\nState: %s\nPull: %v\n\n", issue.Title, issue.Number, issue.State, job.IsPull)
	issueMD.WriteString("## Labels\n")
	for _, l := range issue.Labels {
		fmt.Fprintf(&issueMD, "- %s\n", l.Name)
	}
	issueMD.WriteString("\n## Assignees\n")
	for _, a := range issue.Assignees {
		fmt.Fprintf(&issueMD, "- %s\n", a.name())
	}
	issueMD.WriteString("\n## Body\n\n")
	issueMD.WriteString(issue.Body)

	var commentsMD strings.Builder
	for _, c := range comments {
		fmt.Fprintf(&commentsMD, "### comment %d\n\n%s\n\n", c.ID, c.Body)
	}

	var linkedMD strings.Builder
	for _, n := range linkedIndexes(issue.Title, issue.Body, comments) {
		if n == job.Number {
			continue
		}
		other, err := s.getIssue(ctx, job.Owner, job.Repo, n)
		if err != nil {
			fmt.Fprintf(&linkedMD, "# %d (fetch failed)\n\n", n)
			continue
		}
		fmt.Fprintf(&linkedMD, "# #%d %s\n\n%s\n\n", other.Number, other.Title, other.Body)
	}

	runtime := s.cfg.Runtime
	if _, err := exec.LookPath(runtime); err != nil {
		if _, err2 := exec.LookPath("docker"); err2 == nil {
			runtime = "docker"
		}
	}
	vol := fmt.Sprintf("atlas-bot-job-%s-%s-%d-%d", job.Owner, job.Repo, job.Number, time.Now().UnixNano())
	if out, err := exec.CommandContext(ctx, runtime, "volume", "create", vol).CombinedOutput(); err != nil {
		return "", fmt.Errorf("volume create: %s %w", out, err)
	}
	defer func() { _ = exec.Command(runtime, "volume", "rm", vol).Run() }()

	if err := s.stageFile(ctx, runtime, vol, "context/instruction.md", job.Instruction); err != nil {
		return "", err
	}
	if err := s.stageFile(ctx, runtime, vol, "context/issue.md", issueMD.String()); err != nil {
		return "", err
	}
	if err := s.stageFile(ctx, runtime, vol, "context/comments.md", commentsMD.String()); err != nil {
		return "", err
	}
	if err := s.stageFile(ctx, runtime, vol, "context/linked.md", linkedMD.String()); err != nil {
		return "", err
	}
	if diff != "" {
		if err := s.stageFile(ctx, runtime, vol, "context/diff.patch", diff); err != nil {
			return "", err
		}
	}

	runCtx, cancel := context.WithTimeout(ctx, s.cfg.JobTimeout)
	defer cancel()
	args := []string{
		"run", "--rm",
		"--name", "atlas-bot-" + vol,
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges:true",
		"--memory", "4g",
		"--cpus", "2",
		"--pids-limit", "256",
		"--read-only",
		"--tmpfs", "/tmp:rw,exec,size=1073741824",
		"-v", vol + ":/work",
		"-e", "FORGEJO_TOKEN=" + s.cfg.Token,
		"-e", "AI_PROXY_API_KEY=" + s.cfg.AIProxyKey,
		"-e", "FORGEJO_BASE=" + s.cfg.ForgejoBase,
		"-e", "REPO_OWNER=" + job.Owner,
		"-e", "REPO_NAME=" + job.Repo,
		"-e", "ISSUE_NUMBER=" + fmt.Sprintf("%d", job.Number),
		"-e", "IS_PULL=" + fmt.Sprintf("%v", job.IsPull),
		"-e", "INSTRUCTION=" + job.Instruction,
		s.cfg.DSHImage,
	}
	cmd := exec.CommandContext(runCtx, runtime, args...)
	out, err := cmd.CombinedOutput()
	log.Printf("sandbox exit vol=%s err=%v bytes=%d", vol, err, len(out))

	cat := exec.CommandContext(ctx, runtime, "run", "--rm",
		"-v", vol+":/work:ro",
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges:true",
		"busybox:1.36",
		"sh", "-c", "cat /work/result.md 2>/dev/null || true",
	)
	resultB, _ := cat.Output()
	result := strings.TrimSpace(string(resultB))
	if err != nil && result == "" {
		return "", fmt.Errorf("dsh: %w\n%s", err, trim(string(out), 4000))
	}
	return result, err
}

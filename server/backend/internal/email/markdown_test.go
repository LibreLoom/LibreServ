package email

import (
	"strings"
	"testing"
)

// TestMarkdownSanitization guards against XSS regressions in the email
// markdown renderer: raw HTML must be neutralized, text must be escaped, and
// link destinations must not break out of their href attribute.
func TestMarkdownSanitization(t *testing.T) {
	cases := []struct {
		in             string
		mustNotContain string
	}{
		{`hello <script>alert(1)</script> world`, "<script"},
		{`hello <script>alert(1)</script> world`, "</script"},
		{`**bold** <img src=x onerror=alert(1)>`, "<img"},
		{`**bold** <img src=x onerror=alert(1)>`, "onerror=alert(1)"},
		{`[click](javascript:alert(1)" onmouseover="x)`, `href="javascript`},
		{`text with <b>html</b>`, "<b>html</b>"},
		{`<table><tr><td>X</td></tr></table>`, "<table>"},
	}
	for _, c := range cases {
		out := RenderMarkdownToHTML(c.in)
		if strings.Contains(out, c.mustNotContain) {
			t.Errorf("RenderMarkdownToHTML(%q) still contains %q:\n%s", c.in, c.mustNotContain, out)
		}
	}
}

// TestMarkdownStillRenders ensures legitimate markdown is not broken by the
// sanitization changes.
func TestMarkdownStillRenders(t *testing.T) {
	out := RenderMarkdownToHTML("**Hello** world")
	if !strings.Contains(out, "Hello") || !strings.Contains(out, "<strong") {
		t.Errorf("legitimate markdown broken:\n%s", out)
	}
}

// TestMarkdownEscapesInlineText ensures a `<` in ordinary paragraph text is
// HTML-escaped rather than passed through.
func TestMarkdownEscapesInlineText(t *testing.T) {
	out := RenderMarkdownToHTML("5 < 6 and 7 > 2")
	if !strings.Contains(out, "&lt;") {
		t.Errorf("expected escaped less-than, got:\n%s", out)
	}
}

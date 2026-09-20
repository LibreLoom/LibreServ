package email

import (
	"bytes"
	"fmt"
	"html"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/renderer"
	htmlrenderer "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/util"
)

type inlineStyleRenderer struct {
	htmlrenderer.Config
}

func newInlineStyleRenderer(opts ...htmlrenderer.Option) renderer.NodeRenderer {
	r := &inlineStyleRenderer{}
	for _, opt := range opts {
		opt.SetHTMLOption(&r.Config)
	}
	return r
}

func (r *inlineStyleRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindHeading, r.renderHeading)
	reg.Register(ast.KindParagraph, r.renderParagraph)
	reg.Register(ast.KindText, r.renderText)
	reg.Register(ast.KindEmphasis, r.renderEmphasis)
	reg.Register(ast.KindCodeSpan, r.renderCodeSpan)
	reg.Register(ast.KindLink, r.renderLink)
	reg.Register(ast.KindAutoLink, r.renderAutoLink)
	reg.Register(ast.KindList, r.renderList)
	reg.Register(ast.KindListItem, r.renderListItem)
	reg.Register(ast.KindCodeBlock, r.renderCodeBlock)
	reg.Register(ast.KindFencedCodeBlock, r.renderFencedCodeBlock)
	reg.Register(ast.KindBlockquote, r.renderBlockquote)
	reg.Register(ast.KindThematicBreak, r.renderThematicBreak)
	// KindHTMLBlock / KindRawHTML are intentionally NOT registered here: the
	// default renderer replaces raw HTML with a comment (the markdown renderer
	// is configured without html.WithUnsafe()), so arbitrary HTML in markdown
	// is neutralized instead of passed through to the email.
}

const (
	fontMono    = `'FreeMono','Courier New',Courier,monospace`
	fontSans    = `'Noto Sans','Helvetica Neue',Arial,sans-serif`
	colorBlack  = `#000000`
	colorGrey   = `#767676`
	colorAccent = `#767676`
)

func headingStyle(level int) string {
	sizes := map[int]string{1: "24px", 2: "20px", 3: "18px", 4: "16px", 5: "15px", 6: "14px"}
	size := sizes[level]
	if size == "" {
		size = "16px"
	}
	return fmt.Sprintf(
		`margin:24px 0 12px 0; font-family:%s; font-size:%s; font-weight:700; line-height:1.3; color:%s;`,
		fontMono, size, colorBlack,
	)
}

func (r *inlineStyleRenderer) renderHeading(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.Heading)
	if !entering {
		fmt.Fprintf(w, "</h%d>", n.Level)
		return ast.WalkContinue, nil
	}
	fmt.Fprintf(w, `<h%d style="%s">`, n.Level, headingStyle(n.Level))
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderParagraph(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		w.WriteString("</p>")
		return ast.WalkContinue, nil
	}
	w.WriteString(`<p style="margin:0 0 16px 0; font-family:` + fontSans + `; font-size:16px; line-height:1.6; color:` + colorBlack + `;">`)
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderText(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.Text)
	segment := n.Segment
	// Escape normal text (matching goldmark's default renderer); raw text
	// (e.g. code spans) is intentionally written verbatim. Using Write here —
	// instead of RawWrite — prevents user-controlled content from injecting
	// markup into the email.
	if n.IsRaw() {
		htmlrenderer.DefaultWriter.RawWrite(w, segment.Value(source))
	} else {
		htmlrenderer.DefaultWriter.Write(w, segment.Value(source))
	}
	if n.SoftLineBreak() {
		w.WriteString("\n")
	}
	if n.HardLineBreak() {
		w.WriteString("<br>")
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderEmphasis(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.Emphasis)
	tag := "em"
	style := `style="font-style:italic;"`
	if n.Level == 2 {
		tag = "strong"
		style = `style="font-weight:700;"`
	} else if n.Level == 1 && !entering {
		parent := n.Parent()
		if p, ok := parent.(*ast.Emphasis); ok && p.Level == 1 {
			return ast.WalkContinue, nil
		}
	}
	if entering {
		fmt.Fprintf(w, "<%s %s>", tag, style)
	} else {
		fmt.Fprintf(w, "</%s>", tag)
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderCodeSpan(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		w.WriteString(`<code style="font-family:` + fontMono + `; font-size:14px; background-color:#f0f0f0; padding:2px 6px; border-radius:4px; color:#000000;">`)
	} else {
		w.WriteString("</code>")
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderLink(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.Link)
	if entering {
		// Escape the destination so a crafted URL cannot break out of the
		// href attribute (attribute-injection / XSS).
		url := html.EscapeString(string(n.Destination))
		// Check if this link is the only child of its paragraph (standalone CTA)
		if isStandaloneLink(n, source) {
			fmt.Fprintf(w, `<div style="text-align:center; padding:16px 0;"><a href="%s" style="display:inline-block; background-color:%s; color:#ffffff; padding:14px 32px; border-radius:9999px; text-decoration:none; font-family:%s; font-size:15px; font-weight:700;">`, url, colorBlack, fontSans)
		} else {
			fmt.Fprintf(w, `<a href="%s" style="color:%s; text-decoration:underline; font-weight:600;">`, url, colorBlack)
		}
	} else {
		if isStandaloneLink(n, source) {
			w.WriteString("</a></div>")
		} else {
			w.WriteString("</a>")
		}
	}
	return ast.WalkContinue, nil
}

// isStandaloneLink returns true if the link is the only meaningful child in its
// parent paragraph, making it a standalone call-to-action that should render as
// a pill button rather than an inline underlined link.
func isStandaloneLink(n *ast.Link, source []byte) bool {
	parent := n.Parent()
	if parent == nil || parent.Kind() != ast.KindParagraph {
		return false
	}
	childCount := 0
	for c := parent.FirstChild(); c != nil; c = c.NextSibling() {
		// Skip whitespace-only text nodes
		if c.Kind() == ast.KindText {
			t := c.(*ast.Text)
			if strings.TrimSpace(string(t.Segment.Value(source))) == "" && !t.HardLineBreak() {
				continue
			}
		}
		childCount++
	}
	return childCount == 1
}

func (r *inlineStyleRenderer) renderAutoLink(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.AutoLink)
	if entering {
		url := html.EscapeString(string(n.URL(source)))
		label := html.EscapeString(string(n.Label(source)))
		fmt.Fprintf(w, `<a href="%s" style="color:%s; text-decoration:underline; font-weight:600;">%s</a>`, url, colorBlack, label)
		return ast.WalkSkipChildren, nil
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderList(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	n := node.(*ast.List)
	tag := "ul"
	if n.IsOrdered() {
		tag = "ol"
	}
	style := `margin:0 0 16px 0; padding-left:24px; font-family:` + fontSans + `; font-size:16px; line-height:1.6; color:` + colorBlack + `;`
	if entering {
		fmt.Fprintf(w, `<%s style="%s">`, tag, style)
	} else {
		fmt.Fprintf(w, "</%s>", tag)
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderListItem(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		w.WriteString(`<li style="margin-bottom:4px;">`)
	} else {
		w.WriteString("</li>")
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderCodeBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.CodeBlock)
	w.WriteString(`<pre style="margin:0 0 16px 0; padding:16px; background-color:#f0f0f0; border-radius:12px; overflow-x:auto;"><code style="font-family:` + fontMono + `; font-size:14px; line-height:1.5; color:#000000;">`)
	l := n.Lines().Len()
	for i := 0; i < l; i++ {
		line := n.Lines().At(i)
		htmlrenderer.DefaultWriter.RawWrite(w, line.Value(source))
	}
	w.WriteString("</code></pre>")
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderFencedCodeBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.FencedCodeBlock)
	w.WriteString(`<pre style="margin:0 0 16px 0; padding:16px; background-color:#f0f0f0; border-radius:12px; overflow-x:auto;"><code style="font-family:` + fontMono + `; font-size:14px; line-height:1.5; color:#000000;">`)
	l := n.Lines().Len()
	for i := 0; i < l; i++ {
		line := n.Lines().At(i)
		htmlrenderer.DefaultWriter.RawWrite(w, line.Value(source))
	}
	w.WriteString("</code></pre>")
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderBlockquote(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if entering {
		w.WriteString(`<blockquote style="margin:0 0 16px 0; padding:12px 16px; border-left:4px solid ` + colorAccent + `; background-color:#f8f8f8; font-family:` + fontSans + `; font-size:16px; line-height:1.6; color:` + colorBlack + `;">`)
	} else {
		w.WriteString("</blockquote>")
	}
	return ast.WalkContinue, nil
}

func (r *inlineStyleRenderer) renderThematicBreak(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	w.WriteString(`<div style="margin:16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="height:2px; background-color:` + colorAccent + `; font-size:1px; line-height:1px;">&nbsp;</td></tr></table></div>`)
	return ast.WalkContinue, nil
}

type inlineStyleExtension struct{}

func (e *inlineStyleExtension) Extend(m goldmark.Markdown) {
	m.Renderer().AddOptions(renderer.WithNodeRenderers(
		util.Prioritized(newInlineStyleRenderer(), 1),
	))
}

var md goldmark.Markdown

func init() {
	md = goldmark.New(
		goldmark.WithExtensions(&inlineStyleExtension{}),
	)
}

func RenderMarkdownToHTML(markdown string) string {
	var buf bytes.Buffer
	if err := md.Convert([]byte(markdown), &buf); err != nil {
		return renderMarkdownFallback(markdown)
	}
	return strings.TrimSpace(buf.String())
}

func renderMarkdownFallback(text string) string {
	return convertTextToHTML(text)
}

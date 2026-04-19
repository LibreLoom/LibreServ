#!/bin/bash

# Accessibility Contrast Scanner
# Finds potentially illegible text patterns in JSX files

echo "=== Scanning for Contrast Issues ==="
echo ""

cd "$(dirname "$0")/.."

# Pattern 1: text-secondary on bg-secondary (invisible in both themes)
echo "1. text-secondary on bg-secondary (CRITICAL)"
echo "   ────────────────────────────────────────"
grep -rn "bg-secondary.*text-secondary\|text-secondary.*bg-secondary" src --include="*.jsx" | grep -v "hover:" | grep -v "test" | grep -v "placeholder:"
echo ""

# Pattern 2: Very low opacity text (< 50%) on any background
echo "2. Very low opacity text (< 50%) - potentially illegible"
echo "   ─────────────────────────────────────────────────────"
grep -rn "text-primary/[0-4]0\|text-secondary/[0-4]0" src --include="*.jsx" | grep -v "hover:" | grep -v "test" | grep -v "placeholder:" | head -30
echo ""

# Pattern 3: text-accent used for content text (fails WCAG)
echo "3. text-accent for content text (fails WCAG AA)"
echo "   ─────────────────────────────────────────────"
grep -rn "text-accent[^/]" src/pages --include="*.jsx" | grep -v "hover:" | grep -v "test" | head -20
echo ""

# Pattern 4: Status colors used as text on light backgrounds
echo "4. Status colors as text (may fail on light backgrounds)"
echo "   ─────────────────────────────────────────────────────"
grep -rn "text-success\|text-warning\|text-error\|text-info" src/components --include="*.jsx" | grep -v "bg-" | grep -v "hover:" | grep -v "test" | head -20
echo ""

# Pattern 5: Check for bg-secondary containers with text-secondary children
echo "5. bg-secondary containers (checking children for text-secondary)"
echo "   ─────────────────────────────────────────────────────────────"
grep -B5 "bg-secondary" src/pages --include="*.jsx" -r | grep "text-secondary" | grep -v "hover:" | grep -v "test"
echo ""

echo "=== Scan Complete ==="
echo ""
echo "Recommendations:"
echo "  - text-secondary should ONLY be used on bg-primary"
echo "  - text-primary should be used on bg-secondary"
echo "  - Avoid opacity values below 60% for body text"
echo "  - Avoid text-accent for readable content"

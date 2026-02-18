# Contributing to LibreServ

Thanks for your interest in contributing! This guide outlines two ways to contribute:

1. **Freeform** - Work on anything, submit when ready
2. **Task-Claim** - Claim a ROADMAP task, get it assigned, submit PR

Both are valid. Use whichever fits your style.

---

## Quick Reference

| What | How |
|------|-----|
| See available tasks | [ROADMAP.md](ROADMAP.md) |
| Claim a task | Comment on Gitea issue |
| Submit work | Open a Pull Request on Gitea |
| Get help | Gitea Issues |

---

## Option 1: Freeform Contribution

The simplest approach:

1. **Find something to work on**
   - Browse [ROADMAP.md](ROADMAP.md) for ideas
   - Check existing [issues](https://gt.plainskill.net/LibreLoom/LibreServ/issues)
   - Fix a bug you encountered
   - Improve documentation

2. **Do the work**
   - Fork the repo on Gitea
   - Make your changes
   - Test locally

3. **Submit a PR**
   - Push to your fork
   - Open a Pull Request on Gitea
   - Describe what you changed and why

That's it. No formal process required.

---

## Option 2: Task-Claim Process

For structured contributions, especially for ROADMAP tasks:

### Step 1: Find a Task

Browse [ROADMAP.md](ROADMAP.md) and find a task marked 🔴 (not started).

Look for tasks with **no dependencies** or dependencies that are ✅ complete.

### Step 2: Claim the Task

**Via Gitea Issue:**
1. Find or create an issue for the task (e.g., "T1.1.1: Setup Wizard Page")
2. Comment: "I'm working on this"
3. A maintainer will assign you and update ROADMAP.md status to 🟡

### Step 3: Do the Work

1. **Create a branch** named after the task:
   ```bash
   git checkout -b task/T1.1.1-setup-wizard
   ```

2. **Implement** following the acceptance criteria in ROADMAP.md

3. **Test** your changes:
   ```bash
   # Full Suite
   ./ci run -profile full
   # Interactive Mode
   ./ci
   ```

4. **Update status** in ROADMAP.md:
   ```markdown
   #### T1.1.1. Create Setup Wizard Page
   **Status:** 🟡 In Progress
   **Completed By:** @yourusername
   ```

### Step 4: Submit PR

1. **Push your branch:**
   ```bash
   git push origin task/T1.1.1-setup-wizard
   ```

2. **Open a Pull Request** on Gitea with:
   - Title: `[T1.1.1] Create Setup Wizard Page`
   - Description:
     ```markdown
     ## Task
     Implements T1.1.1 from ROADMAP.md
     
     ## Changes
     - Created SetupWizardPage.jsx
     - Added route in App.jsx
     - Added preflight checks component
     
     ## Acceptance Criteria
     - [x] Page checks /api/v1/setup/status on load
     - [x] If setup complete, redirects to login
     - [x] Shows preflight check results with icons
     - [x] Form validates password strength
     - [x] Shows plain-language errors
     - [x] Success redirects to dashboard
     - [x] Works on mobile/tablet
     
     ## Testing
     - Manual testing with fresh database
     - Tested on mobile viewport
     ```

3. **Link the PR** to any related issues

### Step 5: Review & Merge

1. Maintainer reviews your PR
2. Address any feedback
3. Once approved, maintainer merges
4. ROADMAP.md is updated to ✅

---

## Branch Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Task | `task/T{id}-{short-desc}` | `task/T1.1.1-setup-wizard` |
| Bug fix | `fix/{short-desc}` | `fix/login-redirect` |
| Feature | `feat/{short-desc}` | `feat/dark-mode` |
| Docs | `docs/{short-desc}` | `docs/api-reference` |

---

## Commit Message Format

Use conventional commits:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation
- `style`: Formatting
- `refactor`: Code restructuring
- `test`: Adding tests
- `chore`: Maintenance

**Examples:**
```
feat(setup): add Setup Wizard page

- Create SetupWizardPage.jsx
- Add preflight checks component
- Integrate with /api/v1/setup endpoints

Closes #123
```

```
fix(auth): redirect after login

Login was redirecting to / instead of /dashboard
when user had a saved redirect path.

Fixes #456
```

---

## Code Style

### Go
- Run `go fmt` before committing
- Run `go vet ./...` - no warnings
- Follow [Effective Go](https://golang.org/doc/effective_go)

### JavaScript/React
- Run `npm run lint` - no errors
- Use functional components with hooks
- Follow existing patterns in codebase

---

## Testing

### Backend Tests

```bash
cd server/backend

# Run all tests
go test ./...

# Run with verbose output
go test -v ./...

# Run specific package
go test -v ./internal/apps

# Run specific test
go test -v -run TestAppLifecycle ./internal/apps

# Run with coverage
go test -cover ./...

# Generate coverage report
go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out
```

### Frontend Tests

```bash
cd server/frontend

# Run tests
npm test

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

### Integration Tests

```bash
# These require Docker running
cd server/backend
go test -v -tags=integration ./tests/integration/...
```

---

## Need Help?

- **Gitea Issues** - For bug reports, feature requests, and questions
- **docs/DEVELOPER_GUIDE.md** - For development setup and testing details

---

## Task Status Legend

| Status | Meaning |
|--------|---------|
| 🔴 | Not started - Available to claim |
| 🟡 | In progress - Someone is working on it |
| ✅ | Complete - Merged to main |
| ⏸️ | Blocked - Waiting on dependency |

---

## Quick Start for First-Time Contributors

1. Read [ROADMAP.md](ROADMAP.md)
2. Find a task marked 🔴 with no dependencies
3. Claim it via Gitea issue
4. Fork, branch, implement, test
5. Submit PR on Gitea

Welcome aboard!

# JS package manager for host-run Makefiles. Include it, then use $(PM),
# $(PM_INSTALL) and `$(PM) run <script>` (never bare `$(PM) test`: bun has its
# own test runner). Prefers npm; warns and falls back to pnpm, then bun.
# Force one with `make <target> PM=pnpm`. Containers, CI and release builds pin
# npm themselves and do not use this.
ifndef PM
  PM := $(firstword $(foreach p,npm pnpm bun,$(if $(shell command -v $(p) 2>/dev/null),$(p))))
  ifeq ($(PM),)
    $(error No JavaScript package manager found. Install npm, pnpm or bun)
  else ifneq ($(PM),npm)
    $(shell echo "warning: npm is not installed, using $(PM) instead" >&2)
  endif
  # Sub-makes inherit the choice instead of detecting (and warning) again.
  export PM
endif

PM_INSTALL = $(if $(filter npm,$(PM)),npm install --no-audit --no-fund,$(PM) install)

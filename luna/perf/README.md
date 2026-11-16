# Luna performance budgets

`budgets.json` is the single list of user journeys and their goals. Every
timing point in the code carries its journey ID (`W4`, `D5`, …) so a result
maps straight back to a budget.

- **Reference hardware:** Dell Wyse 3040 (2 GiB RAM). Times are p95.
- **Approach:** measure the journeys, profile only what is over budget, fix,
  measure again. Commits that claim a speed-up carry before/after numbers.
- **Data:** generated fixtures live in `perf/data/` and results in
  `perf/results/`; both are gitignored.
- **Runs need the user's go-ahead** (see AGENTS.md → Running tests).

Where each product is measured is described in the sections below as the
harness lands.

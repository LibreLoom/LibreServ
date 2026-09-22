# @libreloom/ui

Shared design-system components for the LibreLoom web apps (Sol web, Luna web).

This package replaces hand-synced copies — previously `components/ui`,
`components/common`, `components/cards` leaf files were duplicated between
`sol/server/frontend` and `luna/web` and kept "in sync" by hand (they were not).

## Layout

Mirrors the app `src/` tree:

- `components/ui|common|cards|setup/` — leaf components (Button, Tooltip, Card…)
- `hooks/` — useAnimatedHeight, useTheme, useShakeOnError, useSmoothResize, useLabelErrorState
- `lib/` — cn (utils.js), ui-tokens, passwordPolicy
- `utils/` — haptics, shake, clipboard

## Rules

- **Edit here, not in the apps.** If a component needs product-specific
  behavior, add a prop — do not fork the file.
- Components use theme tokens (`bg-primary`, `text-secondary`, …) — apps
  provide them via their own `index.css`. Never hardcode colors.
- Everything ships as raw `.jsx` source; each app's Vite/Tailwind/tsc
  compiles and checks it. Vite realpaths the `file:` link into `shared/ui`, so
  this package needs its peer imports installed (`npm ci` in `shared/ui/`
  before an app build, as `luna/ci.sh` and `.cursor/install.sh` do).
- Tests live beside the component (`*.test.jsx`) and run in this package's
  own vitest suite: `cd shared/ui && npm test`. Typecheck: `npm run typecheck`.

## Not shared (yet)

Page-level and product-specific components stay in each app:
`settings/categories/*`, `FormInput`, `OtpInput`, `TextLink`, `Navbar`, and
everything under `components/{app,files,gallery,onboarding,…}`.
The connect webs (`sol/connect/web/*`, `luna/connect/web`) use a separate
shadcn-style kit — a second extraction candidate.

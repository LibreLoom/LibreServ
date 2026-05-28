Fixed all TypeScript typecheck errors across the frontend codebase. From ~270+ errors to 0.

Approach:
- Added JSDoc `@param` annotations to ~50+ component functions to properly type props
- Used `/** @type {any} */` casts for test file mocks, `import.meta.env`, Date arithmetic, error cause
- Fixed destructuring patterns by extracting named props with proper types
- Fixed state typing for `useState({})` patterns
- Fixed vitest mock function typing with type casts
- Used `@ts-ignore` for dynamic imports and side-effect CSS imports
- Fixed `inline` property destructuring in react-markdown code renderers
- Fixed JSX boolean attributes (inert, aria-*)
- Fixed Error constructor usage to avoid lib target issues

Key files modified: api.js, api.test.js, Login.test.jsx, SettingsPage.test.jsx, NetworkCategory.test.jsx, and many component/hook files across the codebase.

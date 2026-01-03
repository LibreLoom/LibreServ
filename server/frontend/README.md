# LibreServ Frontend (React + Vite)

This is the web UI for LibreServ. It is a Vite/React app with ESLint enabled. The backend serves static assets from `server/backend/OS/dist/` (ignored in git).

## Quick start
```bash
cd server/frontend
npm install
npm run dev     # start dev server with HMR
npm run build   # produce production assets
```

To serve from the Go backend, copy the build output:
```bash
npm run build
cp -r dist ../backend/OS/dist
```
Then restart the backend.

## Scripts
- `npm run dev` – local development server
- `npm run build` – production build
- `npm run preview` – serve the built assets locally
- `npm run lint` – ESLint checks
- `npm run scan:colors` – scan for hardcoded colors (CI enforced)

### Color scan suppressions
Use only with a clear reason; CI treats missing reasons as errors.
- `// color-scan: ignore-next-line <reason>`
- `// color-scan: ignore-line <reason>`
- `// color-scan: ignore-file <reason>`

## Prereqs
- Node.js 18+ and npm

## Notes
- Keep `dist` out of git; the backend README documents the deployment flow.

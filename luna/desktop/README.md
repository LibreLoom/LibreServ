# Luna Desktop

Tauri 2 app (Windows/macOS/Linux): folder backup and one-click WebDAV mounts.

- Backup uses Luna's resumable chunked upload API, watches the chosen folder,
  and retries changed files.
- "Open as folder" mounts `/dav/{drive_id}` with the OS-native WebDAV client.

Build: `npm install && npm run tauri -- build --no-bundle`

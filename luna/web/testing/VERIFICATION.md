# Verifying the 2026-11-06 Luna UI fixes

Open `http://localhost:3001/__states` from `cd luna/web && npm run dev`. Each row below is a scenario in the left list; the middle frame starts at the right place, and the right panel's **what to check** list is the acceptance test. The three file-operations-card scenarios marked **needs review** are deliberately left untouched.

| Issue | Scenario | What to do |
|---|---|---|
| Encryption menu as a page | `files/encryption` | On Files, press Encryption on a drive. It opens a sheet, not a page; state pill, actions and progress live there. |
| Encryption “succeeds” while the drive is unreadable | `files/encryption` | Encrypt, confirm the wipe, then watch the sheet. “Drive encrypted” appears only after the sheet has seen the drive finish; the card then shows Locked. |
| Locked drive flow | `files/encryption-locked` | Open Encryption on the locked drive; wrong password stays inline, right one unlocks. |
| Wipe flow | `files/encryption`, `files/encryption-locked` | The wipe dialog is the same confirmation for encrypt/decrypt/reformat, lists what is on the drive and waits before the destructive button. |
| Unreadable health report | `files/health-unknown` | No Drive health section, no health pill, no warning notice. |
| Shared-page spinner not centred | `shared/loading` | Throttle the shared request; the loading line sits centred like Photos. |
| White hairline on shared rows | `shared/many` | Hover rows: no white seams between cells. |
| `/` on Shared | `shared/many` | Press `/` outside a field: the Find a shared item box focuses. |
| “Skips empty folders” menu line | `files/upload-folder` | Open Upload: no second line under Upload a folder; picking an empty folder explains why. |
| Member “Your folders” | `dashboard/member-calm` | The drive column is titled Your files. |
| 24-word recovery phrase copy | `settings/phrase-not-set`, `settings/phrase-24-words` | The phrase dialog says why to choose 24 words before the choice; a 24-word phrase gets 24 boxes. |
| Recovery phrase modal doesn’t close | `settings/phrase-not-set` | Save the phrase: the dialog closes and the card says Ready. |
| `/recover` UI | `recovery/create`, `recovery/phone-dark` | The page is a compact card; account choices are a two-column list; token is a toggle; instructions collapse. |
| Update source mess | `settings/update-source` | The source sits in its own panel on the card, with readable text, the address on its own line, and the edit sheet behind Edit update source. |
| Stable ↔ Beta blocked by private-network error | `settings/update-source`, `settings/update-source-lan-feed` | Switch channels; the feed address stays and no error appears. |
| Caution triangle contrast | `settings/update-source` | Open Edit update source: the warning icon is primary-coloured on its tint. |
| Add-user role padding | `settings/users-many` | Open Add user: the Role row has space above it. |
| Non-self edit page | `settings/edit-user`, `settings/edit-user-save-fails`, `settings/edit-user-phone` | Open the pencil on Sam: the Edit modal matches Add a user; save closes it; a failure stays inside it. |
| Edit yourself | `settings/edit-user-self` | Your own row opens Settings → Security instead of a modal. |
| Sharing users not mono | `share/many-people` | Names in the People rows are monospace. |
| “Copy address” on links | `share/links-all-states` | A link row’s copy button says Copy link. |
| Guest editors don’t show in markdown | `public/file-edit` (real lunad) | Two windows on one full link see each other in the Live peers row; the owner sees Guest. |
| Share button in the editor sidebar | `files/edit-markdown` | The fullscreen rail has Share; it opens the sharing sheet. |
| Realtime form presence | `files/edit-form`, `files/edit-form-collab` (real lunad) | Edit a form; the card being worked in gets the peer’s colour and name chip, not a text cursor. |
| Link shares cannot save | `public/file-edit` (real lunad) | Edit a text file through a full link, save, reopen: the change is there under the same name. |
| Member dashboard folder wording | `dashboard/member-calm` | Your files. |
| Test scenarios moved on | `settings/users-orphans`, `settings/cloud-backups`, `files/upload-folder` | These no longer mention the retired edit page, the separate Cloud backup entry or the folder-menu second line. |
| Photos pages don’t animate | `gallery/segment-motion` | Library → Albums slides in from the right; back comes from the left; an album slides in. Reduce Motion drops it. |
| Custom colours card | `settings/appearance` | Enable custom colours: presets and three compact colour rows; Reset to default at the bottom. |
| Orphan private folders | `settings/users-orphans`, `files/private-ownerless` | The ownerless card lists each folder with its drive and its own Give control; giving one leaves the other. |
| Cloud backup separate entry | `settings/cloud-backups` | Settings → Luna Connect holds both the address and cloud backup. |
| File open/close lag | `files/open-close-speed` | With 5,000 files, opening and closing a file shows no pause and no growing delay over repeats. |

**Not reachable in the fake:** saving through a full link and live presence (`public/file-edit`, `files/edit-form-collab`) need the real lunad collab/upload path; those scenarios are marked `realLunadOnly` and say so.

**Left for your review (unchanged):** `files/empty-drive`, `files/trash-empty-slow`, `files/upload-duplicate`.

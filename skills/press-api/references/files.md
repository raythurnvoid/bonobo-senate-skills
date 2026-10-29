# Files

Use the [route index](references/route-index.md) for caller kinds. Paths are workspace-relative and start with `/`. Public reads select saved files for every caller, including short grants. Pending creates are missing until Save. Pending moves, replacements, and deletes do not change the saved path or content. Bash remains pending-aware.

## List and access

POST `/api/v1/files/list` with `{ path, cursor: null, limit: 100 }`. Optional fields are `recursive`, `kind: "file" | "folder"`, `extension`, `contentTypePrefixes`, and `order: "asc" | "desc"`. `scanLimit` is accepted and ignored. The page size is at most 100. Without `recursive`, it lists direct children in name order, or reverse name order with `order: "desc"`. A cursor works only with the order it was made for. With `recursive: true`, it walks in path order.

Success is `{ items, cursor, isDone }`. Items have `path`, `name`, `kind`, `nodeId`, `contentType`, `updatedAt`, `status`, `size`, and `locked`. A file's status is `pending` until its upload is confirmed, then `ready`. Folders and locked items have `status: null`. Missing sizes are `null`.

List a readable folder to see its locked children. A locked row gives file facts, not content or custom fields. Recursive reads show a locked boundary once and never enter a locked folder. A guest with an exact folder share may get 403 for `/`; list the shared path instead.

- Missing or archived folder: 404 `Folder not found: <path>`.
- Locked folder or file, or any path below a locked folder: 403 `Permission denied: <path>`. A missing descendant under that folder gets the same refusal.
- Readable file passed as a folder: 400 `Path must point to a folder: <path>`.

Keep all list fields unchanged while following a cursor. A short page is not the end: follow until `isDone`. Move, Rename, access context, or membership changes can end a cursor. On 400 `errorCode: "invalid_cursor"`, restart with `cursor: null` and deduplicate already returned node IDs. Do not inspect or edit the sealed cursor.

`extension: "md"` selects one extension. For type families use `recursive: true` and 1–8 `contentTypePrefixes`, with no extension. Values are whole families such as `image/` or exact types such as `image/png`; `image/p` is an exact type, not a prefix search. Filters use indexes. Narrowing the output does not open locked folders.

## Check paths, make folders, delete, restore, move, copy

`stat` takes `{ paths }`, 1 to 100 absolute paths, not `/`. Success is `{ items: [{ path, status, item? }] }`, in the order sent. `found` comes with `item`, the same shape as a `list` item. A locked item in a readable folder is `found` with `locked: true`. `denied` is a path inside a locked folder; it answers the same whether the name exists or not. `missing` means nothing is there.

`mkdir` takes `{ paths }`, 1 to 20 canonical folder paths with no repeats. It works like `mkdir -p`: it makes the missing folders above too, and an existing folder answers `created: false`, also a locked one you can see in its folder. Success is `{ items: [{ path, nodeId, created }] }`. It is all or nothing: one refusal makes no folder and answers `{ message, path }` with 403 `Permission denied`, 409 when a file is at the path or in the way, or 400 for a bad path or a name, path, or folder limit. Making folders needs no credits.

`delete` takes `{ paths }`, 1 to 200 absolute paths with no repeats, not `/`. Split a longer list into several calls. A key bound to a service account deletes only what the account itself may change. It works like `rm -r` with several paths: it archives what it can and refuses each bad path alone. `restore` and the app Trash bring archived items back. Success is `{ jobId, isDone, refused: [{ path, message }] }`. `refused` names missing paths (`Not found`), locked paths and paths inside a locked folder (`Permission denied`), and items the job refused, such as a read-only file inside a folder. A big folder goes on in the background: `isDone: false` with a `jobId`. `jobId` is `null` when nothing is left to follow. An item that is already archived is skipped, like `rm -f`, so a retry is safe. 429 means too many changes in a row; wait `retryAfterMs`.

`restore` takes `{ paths, onConflict?, requestId }`. `paths` is 1 to 100 absolute paths of deleted items, with no repeats, not `/`. Split a longer list into several calls. `requestId` works like in `move`. It needs a personal key; a key bound to a service account gets 403. It works like Restore in the app Trash: each path brings back everything that the same `delete` call archived with it, so restoring one file of a deleted folder brings back the whole folder. Each item comes back where it was. When its folder is gone, it comes back at the workspace root. `onConflict` says what happens when an item with the same name is already there: `keep_both` (the default) restores it with a new name such as `notes-2.md`, and `skip` leaves it deleted. `jobs/get` names each item that got a new name or stayed deleted. A job stops with a message when Keep both finds no free name.

Success is `{ jobIds, isDone, refused: [{ path, message }] }`. There is one job for each `delete` call the paths came from; read each one with `jobs/get` (it needs `files:list`), also when `isDone` is `true`, because only the job names the items that came back with a new name or stayed in the Trash. `refused` names paths with no deleted item (`Not found`), paths of items that are not deleted (`Not in the Trash`), locked paths (`Permission denied`), paths deleted more than once (restore the one you want in the app), and paths whose job could not start, with the reason. A job that started but stopped partway (`Stopped partway: …`) keeps what it restored, and it is in `jobIds` too: read it to see what is still in the Trash. The other paths are still restored. Send the same `requestId` and body again after a lost answer: you get the same `jobIds` back for 7 days, and nothing is restored twice, even if the item was deleted again since. The same `requestId` with another body is 409. 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

`move` and `copy` take `{ from, to, onConflict?, requestId }`. `from` is 1 to 100 absolute paths with no repeats, not `/`. `requestId` is 1 to 64 characters that you choose, new for each new request. A key bound to a service account moves and copies only what the account itself may read and change. `copy` also needs `files:read` and `files:download`. They work like `mv` and `cp -r`:

- When `to` is an existing folder (or `/`), the `from` paths go inside it. Otherwise `from` must be one path, or the answer is 400. Then `to` is its new path, which is also how to rename. A `to` that ends with `/` must be an existing folder, like in `mv`: 409 otherwise. A `from` path that ends with `/` must be a folder: a file there is refused alone with `Not a folder`.
- The folder above a new `to` path must exist: 409 otherwise. Make it with `mkdir` first. A file in the way is 409 too, and a locked `to` or folder above is 403. A new name must be clean, like in `write` and `upload-urls`: 400 says the name to use instead. The API never renames on its own.
- A missing or locked `from` path is refused alone, like in `delete`, and the rest goes on. When nothing is left, `jobId` is `null`.
- `onConflict` says what happens when a file is already at the destination: `error` (the default for `move`) stops the whole job before it changes anything, `replace` (the default for `copy`) replaces that file, and `skip` keeps it. A copied folder merges into a folder of the same name. Moving a folder onto an existing folder is an error, or is skipped with `skip`.
- A move keeps the rules of the app, and the key's own scopes come on top. A move never makes an item public. A move into, out of, or between restricted folders, or into a folder with added people, needs `files:permissions`. Such an item is refused alone: it shows in the job's `refused` list with a message that names it, and the other items go on.

Success is `{ jobId, isDone, refused: [{ path, message }] }`. The job goes on in the background; read it with `jobs/get`. Send the same `requestId` and body again after a lost answer: you get the same `jobId` back, also after the job has finished, and nothing runs twice. The same `requestId` with another body is 409. A person runs one move or copy at a time per workspace, including ones started in the app: a second one is 409 until the first ends. 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

`jobs/get` takes `{ jobId, cursor? }` and answers `{ jobId, kind: "delete" | "restore" | "move" | "copy", status, progress, errorMessage, refused: [{ path, message }], renamed: [{ path, newPath }], refusedCursor }`. `status` is `queued`, `running`, `succeeded`, `partial` (some items were refused), `failed`, `timed_out`, or `canceled`. For a delete job, a refused `path` is `null` when the key can no longer read that item. A move or copy job keeps the paths it saw when it ran. A move, copy, or restore job gives its items 100 at a time: while `refusedCursor` is not `null`, call again with `cursor: <refusedCursor>`. The paths refused at the start come on the first page only. A copy skips a locked item inside a copied folder and lists it there with `Permission denied`. A delete job has all of them on one page. The last job of a restore lists the paths the restore refused. A restore job lists each item that Keep both brought back under a new name in `renamed`: `path` is where the item was when it was deleted, and `newPath` is where it came back. It lists each item that `skip` left in the Trash in `refused`, with the path it keeps there. A skip does not make the job `partial`. A job that still runs can list more items later, so read it again after it ends. Move and copy never rename, so their `renamed` is empty. When a restore job ends before it brought back everything (it stopped partway, for example because Keep both found no free name), its `refused` names one item still in the Trash. Fix the reason in `errorMessage`, then restore that path to bring back the rest of that delete. Only the key that started the job can read it; another key gets 404 `Job not found`. A finished job is deleted after 7 days, and then it is 404 too. If the key is revoked or loses a scope the job needs while the job still checks items, the job stops and `errorMessage` says so; a delete or move that already passed its check finishes. A restore stops even then.

## Read saved text or binary files

POST `/api/v1/files/read` with `{ path, cursor: null }` for the first page. Only `path` and optional `cursor` are accepted. The server chooses the page size, up to 1,048,576 bytes. Success is raw bytes with `Content-Type: application/octet-stream` and `Cache-Control: no-store`, including for text or JSON files. Use `arrayBuffer()`, not `json()`.

`X-File-Content-Type`, `X-File-Revision`, and `X-File-Size` describe the saved file. When `X-File-Next-Cursor` is present, send it unchanged with the same path for the next page. Stop when the header is absent. A short page alone does not mean EOF. An empty file returns 200 with an empty body and no next cursor. A cursor may be up to 16 KiB; do not inspect, trim, or edit it.

Editable text returns UTF-8 of the latest available saved version. It may lag the open editor. Keep one `TextDecoder` across pages, call `decode(bytes, { stream: true })` for each page, and call `decode()` once at EOF. This keeps characters split between pages intact. Parse JSON or Markdown only after collecting all needed pages.

Errors are JSON with `message` and `errorCode`. Locked paths return 403; missing files return 404. An invalid cursor returns 400 `invalid_cursor`. A changed saved version returns 409 `file_changed`: discard collected pages and start with `cursor: null`. File size alone is never a 404. Access is checked again on every page.

Saved editable text needs `files:read` or `files:download` for keys and short grants. Binary files need `files:download`; plugins keep their existing text-read scope. Short grants share an 8 MiB read budget in one `execute_code` run, across current/personal. Each page reserves its actual planned bytes before I/O. Failed reads and retries are not refunded. Ordinary keys have the page cap and rate limits without that per-run budget. Short grants never mint signed download URLs.

The CLI `call files/read` returns one page only. Its raw bytes go to stdout or `--out`; the file headers go to stderr as JSON. Follow the next cursor with another call. A preview client can stop after its first page and keep only the bytes it needs.

TODO: consider streaming, an optional `pageBytes` hint, and a saved-version freshness signal when callers need them.

## Text writes and empty files

POST `/api/v1/files/write` with `{ path, content, overwrite?: "replace" | "fail", skipIfUnchanged?, nonCollaborative?, contentType? }`. Success includes `path`, `nodeId`, `contentType`, and optionally `unchanged`. Empty text is refused; use `touch` with `{ paths: [...] }` for up to eight empty editable files.

`write-many` takes `{ files: [{ path, content, overwrite?, nonCollaborative?, contentType? }], skipIfUnchanged? }`: at most 20 files and 8,000,000 request bytes. Success is `{ written: [...], errors: [{ path, message, errorCode }] }`. Body validation is for the whole request. Runtime writes have per-item results; do not assume the whole batch rolled back. A mid-batch lost credential (401) or a bad item (400) can stop the batch after earlier writes finished. Reconcile saved results before retrying.

Writes save directly. Filling an editable file keeps its node ID. Replacing a stored binary file archives the old node and creates a new one. `overwrite: "fail"` returns 409 `A file already exists at this path`, also for a visible locked name. Overwriting a locked file, or writing any name below a locked folder, returns 403. Read-only can still refuse an otherwise allowed write.

An omitted type uses the new name's type hint; an existing editable file keeps its stored type. A requested type must be editable and match an existing editable target. `nonCollaborative: true` chooses saved-text storage for a new file; it does not change an existing file's mode. `skipIfUnchanged` can avoid a needless fill. Text saves need available credits and charge a file-save event when content is published. `touch` has no credit gate or save charge.

Names have at most 255 characters; new paths have at most 1,024. One action can add at most 32 new folders per path. Upload batches also limit distinct folder prefixes to 64. Split requests or use a nearer existing folder when a limit refuses a path. Conventional names such as `AGENTS.md` and `SKILL.md` are normalized at creation. Reads keep exact saved paths.

## Uploads and downloads

`upload-urls` takes `{ files: [{ path, contentType, size }], overwrite?, skipProcessing? }`, up to 20 files. Use the returned signed PUT URL and its required headers to send each complete file. Do not send the API key to that URL. Wait for list status `ready`; API acceptance is not proof that the bytes arrived. Uploads need a plan that supports them and available storage. Replacing a path changes its node ID. Editable text uploads convert unless processing is skipped. A signed PUT may remain usable until expiry after key revocation, so do not retain or share it. On a PC, the helper script in [setup](references/setup.md) does these steps for local files and folders.

`download-urls` takes `{ fileNodeIds, expiresInSeconds?, download? }`. Send at most 20 IDs to avoid clipping. Success has `items`, `errors`, and `truncated`; each item has its authorized URL and file facts. Maximum URL life is 900 seconds. `download: true` asks for attachment download. Check every per-ID error; a locked ID says `Permission denied`. URLs are temporary credentials. Do not publish or log them. Files scope checks remain separate from AI transcript access.

## Local Read-only flag

`read-only/get` takes `{ nodeId }` and returns `{ nodeId, readOnly, canEdit }`. `read-only/set` takes `{ nodeId, readOnly }`, where `readOnly` is a boolean. Setting or clearing the flag needs `files:read-only` and current Can edit on the target. A scope alone grants no file access.

The flag stops normal changes to that item. A folder's flag also guards its direct child list, but not content deeper inside. It is separate from sharing. Supported machine writes may send explicit `force: true` with `files:read-only` to pass the flag check. Force never grants access or clears the flag.

## Public flag

`public/set` takes `{ nodeId, public }`, where `public` is a boolean. Success is `{ nodeId, public }`. It needs `files:publish` and a personal key. A public image or video file can show inside public link pages. Only files have the flag; a folder gets 400. It never opens the file by ID. Both On and Off need edit permission on the file, and On also needs read. A scope alone is insufficient.

- A move into another restricted area, a restrict, or an unrestrict turns the flag off. A copy starts off.
- Repeating the current value changes nothing.
- 400: bad body, or a folder. 401: the key or its membership is unavailable. 404: missing, archived, or not editable by the key's user, or not readable for On. 409 (turning on only): the item is being moved, or an access change of the item or a folder above is still running; retry later. 429: too many Sharing changes; wait `retryAfterMs`. 403: other refusals, such as a plugin-bound folder.

Plugin conditional writes, folder access, and sealed uploads have extra fields and retry rules. Read [plugin runtime](references/plugin-runtime.md) before using them. There is no public API to turn "Anyone with the link" share links on or off or retrieve their link tokens. That is separate from `public/set`.

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

`restore` takes `{ paths, onConflict?, requestId }`. `paths` is 1 to 200 absolute paths of deleted items, with no repeats, not `/`. `requestId` works like in `move`. It needs a personal key; a key bound to a service account gets 403. It works like Restore in the app Trash: each path brings back everything that the same `delete` call archived with it, so restoring one file of a deleted folder brings back the whole folder. Each item comes back where it was. When its folder is gone, it comes back at the workspace root. `onConflict` says what happens when an item with the same name is already there: `keep_both` (the default) restores it with a new name such as `notes-2.md`, and `skip` leaves it deleted. A job stops with a message when Keep both finds no free name.

Success is `{ jobIds, isDone, refused: [{ path, message }] }`. There is one job for each `delete` call the paths came from; read each one with `jobs/get`. `refused` names paths with no deleted item (`Not found`), paths of items that are not deleted (`Not in the Trash`), locked paths (`Permission denied`), paths deleted more than once (restore the one you want in the app), and paths whose job could not start, with the reason. The other paths are still restored. Send the same `requestId` and body again after a lost answer: you get the same `jobIds` back for 7 days, and nothing is restored twice, even if the item was deleted again since. The same `requestId` with another body is 409. 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

`move` and `copy` take `{ from, to, onConflict?, requestId }`. `from` is 1 to 100 absolute paths with no repeats, not `/`. `requestId` is 1 to 64 characters that you choose, new for each new request. A key bound to a service account moves and copies only what the account itself may read and change. `copy` also needs `files:read` and `files:download`. They work like `mv` and `cp -r`:

- When `to` is an existing folder (or `/`), the `from` paths go inside it. Otherwise `from` must be one path, or the answer is 400. Then `to` is its new path, which is also how to rename. A `to` that ends with `/` must be an existing folder, like in `mv`: 409 otherwise. A `from` path that ends with `/` must be a folder: a file there is refused alone with `Not a folder`.
- The folder above a new `to` path must exist: 409 otherwise. Make it with `mkdir` first. A file in the way is 409 too, and a locked `to` or folder above is 403. A new name must be clean, like in `write` and `upload-urls`: 400 says the name to use instead. The API never renames on its own.
- A missing or locked `from` path is refused alone, like in `delete`, and the rest goes on. When nothing is left, `jobId` is `null`.
- `onConflict` says what happens when a file is already at the destination: `error` (the default for `move`) stops the whole job before it changes anything, `replace` (the default for `copy`) replaces that file, and `skip` keeps it. A copied folder merges into a folder of the same name. Moving a folder onto an existing folder is an error, or is skipped with `skip`.
- A move keeps the rules of the app, and the key's own scopes come on top. A move that would make an item public on the web needs `files:publish`; an item that was already public through another public folder does not. A move into, out of, or between restricted folders, or into a folder with added people, needs `files:permissions`. Such an item is refused alone: it shows in the job's `refused` list with a message that names it, and the other items go on.

Success is `{ jobId, isDone, refused: [{ path, message }] }`. The job goes on in the background; read it with `jobs/get`. Send the same `requestId` and body again after a lost answer: you get the same `jobId` back, also after the job has finished, and nothing runs twice. The same `requestId` with another body is 409. A person runs one move or copy at a time per workspace, including ones started in the app: a second one is 409 until the first ends. 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

`jobs/get` takes `{ jobId, cursor? }` and answers `{ jobId, kind: "delete" | "restore" | "move" | "copy", status, progress, errorMessage, refused: [{ path, message }], refusedCursor }`. `status` is `queued`, `running`, `succeeded`, `partial` (some items were refused), `failed`, `timed_out`, or `canceled`. For a delete job, a refused `path` is `null` when the key can no longer read that item. A move or copy job keeps the paths it saw when it ran. A move or copy job gives its refused items 100 at a time: while `refusedCursor` is not `null`, call again with `cursor: <refusedCursor>`. The paths refused at the start come on the first page only. A copy skips a locked item inside a copied folder and lists it there with `Permission denied`. A delete job has all of them on one page. The first job of a restore lists the paths the restore refused. Only the key that started the job can read it; another key gets 404 `Job not found`. A finished job is deleted after 7 days, and then it is 404 too. If the key is revoked or loses a scope the job needs while the job still checks items, the job stops and `errorMessage` says so; a delete or move that already passed its check finishes.

## Text and byte reads

| Route suffix under `/api/v1/files/` | Body | Success |
| --- | --- | --- |
| `read` | `{ path, maxBytes? }` | `{ path, target: { kind: "saved", id }, content }` |
| `read-many` | `{ paths, maxBytes? }` | `{ files: [{ path, target, content }], errors: [{ path, message }], truncated }` |
| `read-bytes` | `{ path, offset, length, revision }` | Raw bytes and revision/size headers |

Text reads serve editable Markdown and plain text types. `read` returns a whole file up to 900,000 UTF-8 bytes; `maxBytes` can lower that limit. `read-many` accepts at most 50 paths per effective request, up to 128,000 bytes per file and 384,000 content bytes total. Extra paths or a reached content budget set `truncated`. Send smaller batches to recover the rest; use `read` for a file above the per-item limit. This is not cursor paging. Check `errors` even on HTTP 200.

`read` returns 403 `Permission denied: <path>` for locked paths. Missing or too-large content returns 404 `File not found or exceeds the read limit.` `read-many` reports those messages per path in `errors`.

For exact saved bytes, use `read-bytes` with a canonical path, safe nonnegative integer `offset`, `length` from 1 through 1,048,576, and `revision: null` first. Read with `arrayBuffer()`, not `json()`. Save `X-File-Revision`, then pass it unchanged on later ranges. `X-File-Size`, `X-File-Offset`, and `X-File-Content-Type` describe the saved file. Editable text returns UTF-8 of saved Files text. An empty file or EOF returns an empty 200 body; an offset past EOF returns 416. Revision changes return 409. Errors are JSON. Locked paths return 403; missing files return 404 `File unavailable`.

Short grants share an 8 MiB byte budget in one `execute_code` run, across current/personal. Requested lengths spend the budget before I/O. Failed calls and retries are not refunded. Ordinary keys have the range cap and rate limits without that per-run budget. Short grants never mint signed download URLs.

## Text writes and empty files

POST `/api/v1/files/write` with `{ path, content, overwrite?: "replace" | "fail", skipIfUnchanged?, nonCollaborative?, contentType? }`. Success includes `path`, `nodeId`, `contentType`, and optionally `unchanged`. Empty text is refused; use `touch` with `{ paths: [...] }` for up to eight empty editable files.

`write-many` takes `{ files: [{ path, content, overwrite?, nonCollaborative?, contentType? }], skipIfUnchanged? }`: at most 20 files and 8,000,000 request bytes. Success is `{ written: [...], errors: [{ path, message, errorCode }] }`. Body validation is for the whole request. Runtime writes have per-item results; do not assume the whole batch rolled back. A mid-batch lost credential (401) or a bad item (400) can stop the batch after earlier writes finished. Reconcile saved results before retrying.

Writes save directly. Filling an editable file keeps its node ID. Replacing a stored binary file archives the old node and creates a new one. `overwrite: "fail"` returns 409 `A file already exists at this path`, also for a visible locked name. Overwriting a locked file, or writing any name below a locked folder, returns 403. A write policy can still refuse an otherwise allowed write.

An omitted type uses the new name's type hint; an existing editable file keeps its stored type. A requested type must be editable and match an existing editable target. `nonCollaborative: true` chooses saved-text storage for a new file; it does not change an existing file's mode. `skipIfUnchanged` can avoid a needless fill. Text saves need available credits and charge a file-save event when content is published. `touch` has no credit gate or save charge.

Names have at most 255 characters; new paths have at most 1,024. One action can add at most 32 new folders per path. Upload batches also limit distinct folder prefixes to 64. Split requests or use a nearer existing folder when a limit refuses a path. Conventional names such as `AGENTS.md` and `SKILL.md` are normalized at creation. Reads keep exact saved paths.

## Uploads and downloads

`upload-urls` takes `{ files: [{ path, contentType, size }], overwrite?, skipProcessing? }`, up to 20 files. Use the returned signed PUT URL and its required headers to send each complete file. Do not send the API key to that URL. Wait for list status `ready`; API acceptance is not proof that the bytes arrived. Uploads need a plan that supports them and available storage. Replacing a path changes its node ID. Editable text uploads convert unless processing is skipped. A signed PUT may remain usable until expiry after key revocation, so do not retain or share it. On a PC, the helper script in [setup](references/setup.md) does these steps for local files and folders.

`download-urls` takes `{ fileNodeIds, expiresInSeconds?, download? }`. Send at most 20 IDs to avoid clipping. Success has `items`, `errors`, and `truncated`; each item has its authorized URL and file facts. Maximum URL life is 900 seconds. `download: true` asks for attachment download. Check every per-ID error; a locked ID says `Permission denied`. URLs are temporary credentials. Do not publish or log them. Files scope checks remain separate from AI transcript access.

## Local write policy

`write-policy/get` takes `{ nodeId }`. `write-policy/set` takes `{ nodeId, writePolicy }`. Policies are `null`, `{ mode: "read_only" }`, or `{ mode: "writer", writers: [...] }`. A writer is `{ kind: "user", userId }` or `{ kind: "service_account", serviceAccountId }`. A writer list must contain one or more different active writers. Setting policy requires management permission on that target; a scope alone is insufficient.

## Anyone on the web

`public/set` takes `{ nodeId, public }`, where `public` is a boolean. Success is `{ nodeId, public: "on" | "inherited" | "off" }`. It needs `files:publish` and a personal key. A public file, or a file inside a public folder down to the nearest restricted folder, can show as an image or video on public link pages. A restricted folder inside stays off. It never opens the file by ID. Turning it on needs management and read permission on the target; turning it off needs management. A scope alone is insufficient.

- `inherited` means a public folder above makes the item public. Turning such an item off returns 403; turn it off on that folder.
- Repeating the current value changes nothing.
- 400: bad body. 401: the key or its membership is unavailable. 404: missing, archived, or not managed by the key's user, or not readable for On. 409 (turning on only): the item is being moved, or an access change of the item or a folder above is still running; retry later. 429: too many Sharing changes; wait `retryAfterMs`. 403: other refusals, such as a plugin-bound folder.

Plugin conditional writes, folder access, and sealed uploads have extra fields and retry rules. Read [plugin runtime](references/plugin-runtime.md) before using them. There is no public API to turn "Anyone with the link" share links on or off or retrieve their link tokens. That is separate from `public/set`.

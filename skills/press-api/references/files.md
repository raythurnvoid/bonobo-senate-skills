# Files

Use the [route index](route-index.md) for scopes and caller kinds, and [auth](auth.md) for callers other than a personal key. All routes are POST. Paths are workspace-relative and start with `/`.

Public reads select saved files for every caller, including short grants. Pending creates are missing until Save. Pending moves, replacements, and deletes do not change the saved path or content. Bash remains pending-aware.

## Change a text file safely

Read the file, change it on your computer, and write it back only if nobody saved it in between. The helper CLI is [api.mjs](../scripts/api.mjs).

1. `read /Notes/plan.md --to plan.md`. The JSON it prints has the `revision`.
2. Change `plan.md`. Keep your copy until the write succeeds.
3. Write it back with that revision:
   - the whole file: `write /Notes/plan.md --from plan.md --if-revision <revision>`. The text must not be empty.
   - or one place: `edit /Notes/plan.md --old-file old.txt --new-file new.txt --if-revision <revision>`. To empty a file, use `edit` with the whole old text and an empty new file.
4. 409 `file_changed`: someone saved in between. Read again into another file, redo your change on the new text, and write with the new revision. Never send your old text over theirs.
5. 409 `file_not_latest`: someone is typing, and the saved text does not have their change yet. Wait a little, then read again.
6. 409 `file_busy` (only without a revision): wait, then read again.
7. 409 `file_needs_repair`, or a refusal such as Read-only or a folder at the path: stop. Running it again does not help. Fix the named problem in the app.
8. Exit 3 (the answer was lost): the change may be saved. Read the file again.
   - For `write`: change your text the way the server does (LF line endings, no leading BOM), then compare. Equal means done.
   - For `edit`: check that your change is there.
   - Otherwise go to step 4.

Without the CLI it is the same: read with `files/read` and keep `X-File-Revision`, then send it as `expectedRevision` to `files/write` or `files/edit`.

To create a file only when it is missing, send `overwrite: "fail"`: `call files/write '{"path":"/Notes/new.md","content":"# New\n","overwrite":"fail"}'`. Do not run `stat` and then a plain `write`: another writer can create the file in between, and your write replaces it.

## Read (`files/read`)

Read the saved bytes of a text or binary file, one page at a time. The CLI `read <path> [--to <file>]` follows every page for you.

- Body: `{ path, cursor: null }` for the first page. Only `path` and optional `cursor` are accepted. The server chooses the page size, up to 1,048,576 bytes.
- Success: raw bytes with `Content-Type: application/octet-stream` and `Cache-Control: no-store`, also for text or JSON files. Use `arrayBuffer()`, not `json()`.
- Headers: `X-File-Content-Type`, `X-File-Revision`, and `X-File-Size` describe the saved file. The revision is an opaque string: do not parse it. Send it as `expectedRevision` to change the file only if nobody changed it since.
- `X-File-Is-Latest` comes for every file. `false` means someone is typing in the file and the saved text does not have their changes yet; a conditional change is refused until it does. A stored (binary) file is always `true`.
- Pages: when `X-File-Next-Cursor` is present, send it unchanged with the same path for the next page. Stop when the header is absent. A short page alone does not mean the end. An empty file returns 200 with an empty body and no next cursor. A cursor may be up to 16 KiB; do not inspect, trim, or edit it.
- Editable text returns UTF-8 of the latest available saved version. It may lag the open editor. It is at most 900,000 bytes, so it always fits in one page. A bigger stored file comes in several pages. Over several pages, keep one `TextDecoder`, call `decode(bytes, { stream: true })` for each page, and call `decode()` once at the end. This keeps characters split between pages intact. Parse JSON or Markdown only after you have all the pages you need.
- Errors are JSON with `message` and `errorCode`. Locked path: 403. Missing file: 404. Bad cursor: 400 `invalid_cursor`. A changed saved version: 409 `file_changed`; drop the pages you have and start again with `cursor: null`. File size alone is never a 404. Access is checked again on every page.
- Scopes: saved editable text needs `files:read` or `files:download` for keys and short grants. Binary files need `files:download`; plugins keep their existing text-read scope.
- Short grants share an 8 MiB read budget in one `execute_code` run, across the current workspace and personal/home. Each page reserves its planned bytes before it reads them. Failed reads and retries are not refunded. Ordinary keys have the page cap and rate limits without that per-run budget. Short grants never mint signed download URLs.
- The CLI `call files/read` returns one page only. Its raw bytes go to stdout or `--out`; the file headers go to stderr as JSON. Follow the next cursor with another call. A preview client can stop after its first page and keep only the bytes it needs.

## List (`files/list`)

List the children of a folder, or everything below it.

- Body: `{ path, cursor: null, limit: 100 }`. Optional: `recursive`, `kind: "file" | "folder"`, `extension`, `contentTypePrefixes`, and `order: "asc" | "desc"`. `scanLimit` is accepted and ignored. The page size is at most 100.
- Order: without `recursive`, direct children in name order, or reverse name order with `order: "desc"`. A cursor works only with the order it was made for. With `recursive: true`, path order.
- Success: `{ items, cursor, isDone }`. Items have `path`, `name`, `kind`, `nodeId`, `contentType`, `updatedAt`, `status`, `size`, and `locked`. A file's status is `pending` until its upload is confirmed, then `ready`. Folders and locked items have `status: null`. Missing sizes are `null`.
- Pages: keep every other field unchanged while you follow `cursor`. Stop when `isDone` is `true`; the last page has `cursor: null`. A short page is not the end. Move, Rename, access context, or membership changes can end a cursor. On 400 `errorCode: "invalid_cursor"`, start again with `cursor: null` and skip node IDs you already have. Do not inspect or edit the sealed cursor.
- Filters: `extension: "md"` selects one extension. For type families, use `recursive: true` and 1 to 8 `contentTypePrefixes`, with no extension. Values are whole families such as `image/` or exact types such as `image/png`; `image/p` is an exact type, not a prefix search. Filters use indexes. Narrowing the output does not open locked folders.
- Locked items: list a readable folder to see its locked children. A locked row gives file facts, not content or custom fields. Recursive reads show a locked folder once and never enter it. A guest with an exact folder share may get 403 for `/`; list the shared path instead.
- Errors: missing folder or folder in Trash: 404 `Folder not found: <path>`. Locked folder or file, or any path below a locked folder: 403 `Permission denied: <path>`, also for a missing name below it. Readable file passed as a folder: 400 `Path must point to a folder: <path>`.

## Check paths (`files/stat`)

Say for each path whether something is there. The CLI is `stat <path>... [--expect found|missing|denied]`.

- Body: `{ paths }`, 1 to 100 absolute paths, not `/`.
- Success: `{ items: [{ path, status, item? }] }`, in the order sent.
  - `found` comes with `item`, the same shape as a `list` item. A locked item in a readable folder is `found` with `locked: true`.
  - `denied` is a path inside a locked folder. It answers the same whether the name exists or not.
  - `missing` means nothing is there.

## Write (`files/write`)

Create or replace one editable text file. The CLI is `write <path> --from <file | -> [--if-revision <revision>]`.

- Body: `{ path, content, overwrite?: "replace" | "fail", skipIfUnchanged?, nonCollaborative?, contentType?, expectedRevision? }`.
- Success: `{ path, nodeId, contentType, revision, size, contentChanged }`, plus `unchanged: true` when nothing was saved. `revision` equals the `X-File-Revision` of the next read.
- Empty text is refused. Use [`touch`](#empty-files-filestouch) for new empty files.
- Save rule: the saved text is your text byte for byte, except that line endings become LF and a leading BOM is removed, like in the app's text editor. `contentChanged: true` says this rule changed your text. `skipIfUnchanged` compares the saved bytes, so a change in spacing or line breaks alone is saved.
- `expectedRevision` makes the write conditional. The file must exist and still have that revision. A changed, moved, replaced, or deleted file returns 409 `file_changed`, and nothing is created. A matching revision while someone's typing is not saved yet (`X-File-Is-Latest: false`) returns 409 `file_not_latest`; read again later. It cannot be combined with `overwrite: "fail"`.
- Without `expectedRevision`, the server tries again by itself when someone types during the write, up to three times, then answers 409 `file_busy`.
- A file the app marks for repair returns 409 `file_needs_repair`. A locked path is refused before any revision check.
- Writes save directly. Filling an editable file keeps its node ID. Replacing a stored binary file moves the old node to Trash and creates a new one.
- `overwrite: "fail"` returns 409 `A file already exists at this path`, also for a visible locked name. Overwriting a locked file, or writing any name below a locked folder, returns 403. Read-only can still refuse an otherwise allowed write.
- Type: an omitted type uses the new name's type hint; an existing editable file keeps its stored type. A requested type must be editable and match an existing editable target.
- `nonCollaborative: true` chooses saved-text storage for a new file; it does not change an existing file's mode. `skipIfUnchanged` can avoid a needless fill.
- Text saves need available credits and charge a file-save event when content is published.

## Write many (`files/write-many`)

Write up to 20 editable text files in one request.

- Body: `{ files: [{ path, content, overwrite?, nonCollaborative?, contentType?, expectedRevision? }], skipIfUnchanged? }`, at most 20 files and 8,000,000 request bytes.
- Success: `{ written: [...], errors: [{ path, message, errorCode }] }`. Each written item has the same fields as a `write` answer.
- The whole body is checked first. Then each file saves on its own: a failed file fails alone and is listed in `errors`. Each file follows the `write` rules.
- A lost credential (401) or a bad item (400) in the middle can stop the batch after earlier writes finished. Check what was saved before you send it again.

## Edit and append text

Change part of an existing editable text file (`files/edit`, `files/append`). The CLI is `edit` and `append`.

- `edit` body: `{ path, oldText, newText, expectedRevision?, force? }`. It replaces the one place where `oldText` matches.
- `append` body: `{ path, content, expectedRevision?, force? }`. It adds `content` at the end; it adds no newline.
- Both need an API key with `files:read` and `files:write`, and read and write access to the file.
- Success: the same fields as a `write` answer. Every byte outside the change stays as it was.

- The file must be an existing editable text file: a missing file is 404, a locked one 403, a folder or a stored file 400.
- `oldText` must not be empty. The match is literal, with no trimming or patterns. No match is 409 `text_not_found`. More than one match, also overlapping ones, is 409 `text_not_unique`: add text around it so it matches once. A refusal a save would give (a revoked key, no write access, Read-only, needs repair, or a stale `expectedRevision`) comes first, also before a 400 for a result over the size limit.
- `oldText` equal to `newText`, or an empty `content`, saves nothing and answers `unchanged: true`. An edit may leave the file empty.
- Text with a lone surrogate (not valid Unicode) is 400. The result follows the save rule of `write`.
- When someone is typing in the file, the change starts from their text in the editor, so the saved file has the editor's format. `contentChanged: true` says so; read the file to check.
- `expectedRevision`, retries, and `file_busy` work like in `write`. Without `expectedRevision`, sending an append again after a lost answer can add the text twice. Send `expectedRevision` when you may send the request again.

## Empty files (`files/touch`)

Create up to eight empty editable files.

- Body: `{ paths: [...] }`.
- No credit gate and no save charge.

## Make folders (`files/mkdir`)

Make folders, like `mkdir -p`.

- Body: `{ paths }`, 1 to 20 canonical folder paths with no repeats.
- It makes the missing folders above too. An existing folder answers `created: false`, also a locked one you can see in its folder.
- Success: `{ items: [{ path, nodeId, created }] }`.
- All or nothing: one refusal makes no folder and answers `{ message, path }` with 403 `Permission denied`, 409 when a file is at the path or in the way, or 400 for a bad path or a name, path, or folder limit.
- Making folders needs no credits.

## Delete (`files/delete`)

Move files and folders to Trash, like `rm -r` with several paths.

- Body: `{ paths }`, 1 to 200 absolute paths with no repeats, not `/`. Split a longer list into several calls.
- A key bound to a service account deletes only what the account itself may change.
- It moves what it can to Trash and refuses each bad path alone. `restore` and the app Trash bring items back.
- Success: `{ jobId, isDone, refused: [{ path, message }] }`. `refused` names missing paths (`Not found`), locked paths and paths inside a locked folder (`Permission denied`), and items the job refused, such as a read-only file inside a folder.
- A big folder goes on in the background: `isDone: false` with a `jobId`. `jobId` is `null` when nothing is left to follow.
- An item that is already in Trash is skipped, like `rm -f`, so a retry is safe.
- 429 means too many changes in a row; wait `retryAfterMs`.

## Trash (`files/trash/list`)

List what is in Trash, newest delete first.

- Body: `{ areaNodeId?, folderNodeId?, cursor?, limit? }`, with at most one of `areaNodeId` and `folderNodeId`. `limit` is 1 to 100 (default 100). While `cursor` in the answer is not `null`, call again with it.
- It needs `files:list`. A personal key works, and so does a key bound to a service account: that key acts as the account and sees only what the account may open. A guest gets 403.
- An area is the open part of the workspace (`areaNodeId` missing or `null`) or one restricted folder (its node ID). `files/trash/areas` lists the areas you can open. A restricted folder shows in the area above it, and what is inside it shows only in its own area. A restricted folder you cannot open shows as a locked item; its area answers 403. A missing area answers 404, and a node that is not a restricted folder answers 400.
- Success: `{ items: [{ path, name, kind, nodeId, contentType, updatedAt, size, locked, archiveOperationId, operationAt, changedBy, top }], cursor, isDone }`.
- An area lists what the app Trash shows: the items whose folder was not deleted with them, so `top` is `true` there. Inside one delete they come by path, A to Z. To see the items inside a deleted folder, list that folder with `folderNodeId`.
- `archiveOperationId` names one delete. Restoring a folder brings back only its descendants with the same id. Other items from that delete stay in Trash. `operationAt` is when that delete happened.
- `changedBy` is the user ID of who last changed the item, usually who deleted it. It is `null` for a locked item.
- `folderNodeId` lists only the deleted items directly inside one folder. Use it when you can open a folder but not its area, for example when an account key has a grant on one folder. The folder may itself be in Trash, so you can walk into a deleted folder. A folder you cannot open answers 403, a missing one 404, and a file 400. Here `top: true` means the item was deleted by another delete than the folder.
- An account key with only folder grants gets 403 for the open area. Use `files/trash/areas` or `folderNodeId` instead.
- Plugin frames and runs also work with `workspace.files.read` and applied personal file consent. Whole workspace View or Edit opens the open area. Folder consent opens that folder, even when it is already in Trash. Restricted folders need separate consent. A file-only choice adds no parent access or area. Guests and scheduled runs are refused; scheduled runs get `Scheduled plugin runs cannot use Trash yet.`. Service grants are refused. Plugins see `changedBy` too.
- A bad or old cursor, or a Move that started or ended while you paged, answers 400 with `errorCode: "invalid_cursor"`. Start again without a cursor. Other errors answer `{ message }` only.

## Trash areas (`files/trash/areas`)

List the Trash areas you can open, to pick an `areaNodeId` for `files/trash/list`.

- Body: `{ cursor?, limit? }`. `limit` is 1 to 100 (default 100). While `cursor` in the answer is not `null`, call again with it.
- It needs `files:list`. A personal key works, and so does a key bound to a service account: its areas are the restricted folders shared with the account or its role. A guest gets 403.
- Success: `{ areas: [{ areaNodeId, path }], cursor, isDone }`. The first page starts with the open part of the workspace (`areaNodeId: null`, `path: "/"`) when the key can open the workspace root. Then come the restricted folders you can open, by path. A restricted folder in Trash is not an area.
- Plugin frames and runs page eligible consents in consent order. Applied Whole workspace View or Edit adds `{ areaNodeId: null, path: "/" }` in that page; it need not come first. Their list may include folders that became ordinary or entered Trash while the access update is pending. Use a returned folder ID as `folderNodeId` to list an ordinary folder's deleted children; a non-null `areaNodeId` still means a restricted area. The same capability and guest/scheduled-run rules as Trash list apply.
- A bad or old cursor, or a Move that started or ended while you paged, answers 400 with `errorCode: "invalid_cursor"`. Start again without a cursor.

## Restore (`files/restore`)

Bring back deleted items, like Restore in the app Trash.

This section is for keys. A plugin run with `workspace.files.restore` can restore too, and its frames and runs read those jobs with `jobs/get`. Plugin answers use other messages and paths; see the plugin SDK README. Plugin frames and service grants cannot restore.

- Body: `{ paths | nodes, onConflict?, requestId?, dryRun? }`. `paths` is 1 to 100 absolute paths of deleted items, with no repeats, not `/`. Split a longer list into several calls. `requestId` works like in `move`; it is required unless `dryRun` is `true`.
- `nodes` picks items from `files/trash/list` instead of paths: `[{ nodeId, archiveOperationId }]`, 1 to 100, with no repeated `nodeId`. Use it when several deleted items have one path. Send `paths` or `nodes`, not both.
- `dryRun: true` says what the restore would do and changes nothing: no file comes back and no job is saved. Send no `requestId`. Success: `{ dryRun: true, complete, refused, jobs }`, where each job has the `jobs/get` fields without `jobId` and `refusedCursor`, plus `hasMoreItems`. `hasMoreItems: true` means the job would rename or skip more items than its `renamed` and `refused` lists show. `complete: false` means a big delete did not finish in the preview, so its later results are not known.
- A personal key works, and so does a key bound to a service account: that key acts as the account in every step, so it brings back only what the account may change.
- Each path or node brings back that item and only its descendants with the same `archiveOperationId`. A file comes back alone. Other items from that delete stay in Trash. A descendant from another delete also stays in Trash. Each item comes back at the path it had when it moved to Trash, like `mkdir -p`. When a folder on that path is gone, renamed, or still in Trash, the restore creates a new folder there. A renamed folder keeps its new name, and an old folder in Trash stays there. A file where a folder should be refuses the restore with `file_in_the_way`.
- Selecting a folder and an item inside it restores each item once. There is still one job per delete id. A job refusal names every original selection from that delete, including a covered child. It never adds unselected items. A retry keeps the original selections and answer.
- `onConflict` says what happens when an item with the same name is already there: `keep_both` (the default) restores it with a new name such as `notes-2.md`, and `skip` leaves it deleted. `jobs/get` names each item that got a new name or stayed deleted. A job stops with a message when Keep both finds no free name.
- Success: `{ jobIds, isDone, refused }`, where each refused item is `{ path, message }` or, for `nodes`, `{ nodeId, path, message }`. There is one job for each `delete` call the paths or nodes came from. Read each one with `jobs/get` (it needs `files:list`), also when `isDone` is `true`, because only the job names the items that came back with a new name or stayed in the Trash.
- `refused` names paths with no deleted item (`Not found`), paths of items that are not deleted (`Not in the Trash`), locked paths (`Permission denied`), paths deleted more than once (find the one you want in `files/trash/list` and restore it by `nodes`), and paths whose job could not start, with the reason.
- A refused node is `{ nodeId, path, message }`. `Not found` and `Permission denied` have `path: null`. "This Trash item changed. List the Trash and pick it again." means the item was restored or deleted again since you listed it.
- A job that started but stopped partway (`Stopped partway: …`) keeps what it restored, and it is in `jobIds` too: read it to see what is still in the Trash. It can still be `stopping` for a short while, so `isDone` can be `false`; wait until `jobs/get` shows it finished. The other paths are still restored.
- Send the same `requestId` and body again after a lost answer: you get the same `jobIds` back for 7 days, and nothing is restored twice, even if the item was deleted again since. The same `requestId` with another body is 409.
- 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

## Move and copy (`files/move`, `files/copy`)

Move, rename, or copy, like `mv` and `cp -r`.

- Body: `{ from, to, onConflict?, requestId }`. `from` is 1 to 100 absolute paths with no repeats, not `/`. `requestId` is 1 to 64 characters that you choose, new for each new request.
- A key bound to a service account moves and copies only what the account itself may read and change. `copy` also needs `files:read` and `files:download`.
- When `to` is an existing folder (or `/`), the `from` paths go inside it. Otherwise `from` must be one path, or the answer is 400. Then `to` is its new path, which is also how to rename. A `to` that ends with `/` must be an existing folder, like in `mv`: 409 otherwise. A `from` path that ends with `/` must be a folder: a file there is refused alone with `Not a folder`.
- The folder above a new `to` path must exist: 409 otherwise. Make it with `mkdir` first. A file in the way is 409 too, and a locked `to` or folder above is 403. A new name must be clean, like in `write` and `upload-urls`: 400 says the name to use instead. The API never renames on its own.
- A missing or locked `from` path is refused alone, like in `delete`, and the rest goes on. When nothing is left, `jobId` is `null`.
- `onConflict` says what happens when a file is already at the destination: `error` (the default for `move`) stops the whole job before it changes anything, `replace` (the default for `copy`) replaces that file, and `skip` keeps it. A copied folder merges into a folder of the same name. Moving a folder onto an existing folder is an error, or is skipped with `skip`.
- A move keeps the rules of the app, and the key's own scopes come on top. A move never makes an item public. A move into, out of, or between restricted folders, or into a folder with added people, needs `files:permissions`. Such an item is refused alone: it shows in the job's `refused` list with a message that names it, and the other items go on.
- Success: `{ jobId, isDone, refused: [{ path, message }] }`. The job goes on in the background; read it with `jobs/get`.
- Send the same `requestId` and body again after a lost answer: you get the same `jobId` back, also after the job has finished, and nothing runs twice. The same `requestId` with another body is 409.
- A person runs one move or copy at a time per workspace, including ones started in the app: a second one is 409 until the first ends.
- 429 means too many changes in a row; wait (`retryAfterMs` when it is there) and send the same request again.

## Jobs (`files/jobs/get`)

Read a job that `delete`, `restore`, `move`, or `copy` started.

- Body: `{ jobId, cursor? }`.
- Success: `{ jobId, kind: "delete" | "restore" | "move" | "copy", status, progress, errorMessage, refused: [{ path, message }] (a restore by `nodes` also has `nodeId`), renamed: [{ path, newPath }], refusedCursor }`.
- `status` is `queued`, `running`, `succeeded`, `partial` (some items were refused), `failed`, `timed_out`, or `canceled`.
- Refused items: for a delete job, a refused `path` is `null` when the key can no longer read that item. A move or copy job keeps the paths it saw when it ran. A copy skips a locked item inside a copied folder and lists it there with `Permission denied`.
- Pages: a move, copy, or restore job gives its items 100 at a time. While `refusedCursor` is not `null`, call again with `cursor: <refusedCursor>`. The paths refused at the start come on the first page only. A delete job has all of them on one page.
- A job that still runs can list more items later, so read it again after it ends.
- Restore jobs: the last job of a restore lists the paths and nodes the restore refused. `renamed` lists each item that Keep both brought back under a new name: `path` is where the item was when it was deleted, and `newPath` is where it came back. `refused` lists each item that `skip` left in the Trash, with the path it keeps there. A skip does not make the job `partial`. Move and copy never rename, so their `renamed` is empty.
- When a restore job stops partway, its `refused` names one unfinished item under its selected roots at their current paths. Fix the reason in `errorMessage`, then restore that item and the items inside it that were moved to Trash with it. Check the other paths you restored too. Unselected siblings stay in Trash and do not count as unfinished work. Successful jobs do not look for unfinished items.
- Only the key that started the job can read it; another key gets 404 `Job not found`. A finished job is deleted after 7 days, and then it is 404 too.
- If the key is revoked or loses a scope the job needs while the job still checks items, the job stops and `errorMessage` says so. A delete or move that already passed its check finishes. A restore stops even then.

## Upload (`files/upload-urls`)

Upload files of any type through signed URLs. On a PC, the helper CLI in [setup](setup.md) does these steps for local files and folders.

- Body: `{ files: [{ path, contentType, size }], overwrite?, skipProcessing? }`, up to 20 files.
- Use the returned signed PUT URL and its required headers to send each complete file. Do not send the API key to that URL.
- Wait for list status `ready`; API acceptance is not proof that the bytes arrived.
- Uploads need a plan that supports them and available storage. Replacing a path changes its node ID. Editable text uploads convert unless processing is skipped.
- A signed PUT may remain usable until it expires after the key is revoked, so do not keep or share it.

## Download URLs (`files/download-urls`)

Get temporary download links by node ID.

- Body: `{ fileNodeIds, expiresInSeconds?, download? }`. Send at most 20 IDs to avoid clipping.
- Success: `items`, `errors`, and `truncated`. Each item has its authorized URL and file facts. Maximum URL life is 900 seconds. `download: true` asks for attachment download.
- Check every per-ID error; a locked ID says `Permission denied`.
- URLs are temporary credentials. Do not publish or log them. Files scope checks remain separate from AI transcript access.

## Read-only flag (`files/read-only/get`, `files/read-only/set`)

The local Read-only flag stops normal changes to one item.

- `read-only/get` takes `{ nodeId }` and returns `{ nodeId, readOnly, canEdit }`. `read-only/set` takes `{ nodeId, readOnly }`, where `readOnly` is a boolean.
- Setting or clearing the flag needs `files:read-only` and current Can edit on the target. A scope alone grants no file access.
- A folder's flag also guards its direct child list, but not content deeper inside. It is separate from sharing.
- Supported machine writes may send explicit `force: true` with `files:read-only` to pass the flag check. Force never grants access or clears the flag.

## Public flag (`files/public/set`)

Turn the Public flag of a file on or off. A public image or video file can show inside public link pages.

- Body: `{ nodeId, public }`, where `public` is a boolean. Success: `{ nodeId, public }`.
- It needs `files:publish` and a personal key. Only files have the flag; a folder gets 400. It never opens the file by ID.
- Both On and Off need edit permission on the file, and On also needs read. A scope alone is insufficient.
- A move into another restricted area, a restrict, or an unrestrict turns the flag off. A copy starts off.
- Repeating the current value changes nothing.
- Errors: 400: bad body, or a folder. 401: the key or its membership is unavailable. 404: missing, in Trash, or not editable by the key's user, or not readable for On. 409 (turning on only): the item is being moved, or an access change of the item or a folder above is still running; retry later. 429: too many Sharing changes; wait `retryAfterMs`. 403: other refusals.
- There is no public API to turn "Anyone with the link" share links on or off or retrieve their link tokens. That is separate from `public/set`.

## Names and limits

- Names have at most 255 characters; new paths have at most 1,024. One action can add at most 32 new folders per path. Upload batches also limit distinct folder prefixes to 64. Split requests or use a nearer existing folder when a limit refuses a path.
- Conventional names such as `AGENTS.md` and `SKILL.md` are normalized at creation. Reads keep exact saved paths.

## Plugin writes

Plugin conditional writes, folder access, and sealed uploads have extra fields and retry rules. Read [plugin runtime](plugin-runtime.md) before using them.

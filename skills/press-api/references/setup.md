# PC setup and the helper script

This guide is for a terminal on a PC. Inside the app, use the hidden grants in [auth](references/auth.md) instead. The helper script there has no key and does not apply.

The helper is [api.mjs](scripts/api.mjs). It needs Node 22 or newer and has no dependencies. Run it by its path inside this skill folder, for example `node <skill folder>/scripts/api.mjs status`.

Run `help` to list every command. `--help` after any command prints the same list.

Exit codes: 0 ok, 1 the API refused something or an upload failed, 2 usage error, 3 cannot reach the API, 4 no API key is set up.

## 1. Check for a key

Run `status` first. It prints where the key came from, the API origin, and the result of `/api/v1/auth/verify` (organization, workspace, scopes). It never prints the key.

- Exit 0: the key works. Check that its scopes cover the task, then go on.
- Exit 4: no key is set up. Go to step 2.
- Exit 1 with `HTTP 401`: the key does not work, for example because it was revoked. Go to step 2 for a new key. Any other exit 1 (a 429 or a server error) passes with time.
- Exit 3: the API cannot be reached. The key may be fine, so do not ask for a new one. Check the network and the sandbox note in step 3.
- No exit code: the script did not start. For example `node` is not found, the run says "Access is denied", or the key file cannot be read. The agent's sandbox blocks the script, so this says nothing about the key. Tell the user to give the session full access, or to allow Node, the network, and the `~/.config/bonobo-senate` folder. Do not work around it.

The script reads `T3_API_KEY` and `T3_API_ORIGIN` when `T3_API_KEY` is set. The origin must use `https`, except for a local server. Otherwise it reads `~/.config/bonobo-senate/credentials.json` (or `$XDG_CONFIG_HOME/bonobo-senate/credentials.json`). The key lives there, outside this skill folder, so a skill update cannot delete it and a copy of the skill cannot carry it. Do not print, copy, or move that file. You may read the key into a variable inside the command that uses it, as [upload](references/upload.md) shows, but only to send a request. Do not open the file to check whether a key exists: `status` is the only check. Never put the key in chat, in a command line, or in a file you write.

## 2. Create a key (the user does this)

Do this only when the user asks for setup. No API route creates a key: only a signed-in user can, on the app's API keys page. Tell the user:

1. Open the workspace in the app, then open **API keys** (`/w/<organization>/<workspace>/api-keys`).
2. Create a personal key (not one bound to a service account) with only the scopes the task needs: `files:list` for `ls`, `stat`, and `job`; `files:read` to read text and for `cp`; `files:write` for `upload`, `mkdir`, `rm`, `restore`, `mv`, `cp`, and writes; `files:download` for download URLs, byte reads, and `cp`.
3. Copy the key. The page shows it only once.
4. Copy the API origin from the "Use an API key" section of the same page (the `T3_API_ORIGIN` value). It is not the app website address.

A key works in one workspace only. Another workspace needs its own key.

If the user asks you to create the key for them, and you can control their signed-in browser, you may do these steps there. Never print the key or write it to a file: copy it with the page's copy button, pipe the clipboard into `login` (step 3), then clear the clipboard.

## 3. Save the key (the user does this)

The user runs `login` in their own terminal, so the key never passes through the agent:

```sh
node <skill folder>/scripts/api.mjs login --origin <api origin>
```

It asks for the key with a hidden prompt, checks it with `/api/v1/auth/verify`, and saves it only when it works. Where the hidden prompt does not work (Git Bash in mintty, for example), pipe the key from the clipboard instead: `Get-Clipboard | node ... login --origin <api origin>` in PowerShell, `cat /dev/clipboard | node ...` in Git Bash, or `pbpaste | node ...` on macOS.

If you can open a terminal tab that the user types into, you may start the command there and let the user paste. Do not ask the user to send you the key. Run `status` again when the user is done.

In a sandbox with a network allowlist (for example the Claude Code sandbox), the API origin's host must be allowed. `upload` also sends the file bytes to a storage host (a `*.r2.cloudflarestorage.com` name), so allow that host too. When it is blocked, each file fails with `Upload PUT failed: 0 cannot reach <host>: ...` and the file stays `pending`. A later `upload` with `--skip-existing` sends it again. The Codex sandbox blocks the network by default, so the user must turn network access on for the session. If requests fail with exit 3, tell the user. Do not move the key somewhere else to work around it.

## 4. Call a route

```sh
node <skill folder>/scripts/api.mjs call files/list '{"path":"/","cursor":null,"limit":100}'
```

`call <route> [json | -]` sends one POST to a route from the [route index](references/route-index.md). Use `-` to read the JSON body from stdin, which avoids shell quoting problems. With no body, it sends none (`auth/verify` needs none).

In Windows PowerShell 5.1, do not pass JSON as an argument: it removes the double quotes inside it before the script sees it. Use `--body-file <file>` with a UTF-8 JSON file. A pipe with `-` also works for plain ASCII, but PowerShell 5.1 turns other characters (such as `é`) into `?` in a pipe unless you first run `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`.

- Success: the JSON response goes to stdout. A raw byte response (`files/read-bytes`) goes to stdout unchanged, or to a file with `--out <file>`, and its `X-File-*` headers (revision, size, offset) go to stderr as JSON. Use `--out` in Windows PowerShell 5.1: its `>` turns bytes into text.
- Failure: `HTTP <status>: <message>` and the JSON error body go to stderr, with exit 1. On 429, `call` waits `retryAfterMs` and tries again, up to 5 times.

## 5. Upload files and folders

```sh
node <skill folder>/scripts/api.mjs upload ./photos ./notes.md --to /Inbox --dry-run
node <skill folder>/scripts/api.mjs upload ./photos ./notes.md --to /Inbox
```

In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` first. Otherwise Git Bash turns `--to /Inbox` into a Windows path such as `C:/Program Files/Git/Inbox`, and the script refuses it. Then write local paths as `C:/...`, not `/c/...`.

The script does not rename files. The server refuses a name that is not clean, for example one that starts with `_` or has a capital letter. Clean the names first, as [upload](references/upload.md) step 2 shows. A local folder keeps its own name under `--to`, like `cp -R`: `./photos/a.png` becomes `/Inbox/photos/a.png`. Missing folders are created. Run `--dry-run` first: it prints every target path, type, and size, and sends nothing.

Hidden files and folders (names that start with `.`, such as `.git` and `.env`) are skipped; the output counts them in `skippedHidden`. Add `--include-hidden` to send them. Symbolic links are never followed; they are listed in `skipped`.

The script follows the upload steps in [Files](references/files.md): `upload-urls` in batches of 20, then one PUT per file, tried once more after a network or storage error. It waits and retries when rate limited. A batch that would add more than 64 folders is sent in smaller parts. When the server refuses one file by path (a name clash with `--overwrite fail`, a locked folder), it reports that file and goes on with the rest. A refusal that hits every file (a bad key, a plan without uploads, full storage) stops the run, and every file left is reported with that reason.

The output is `{ uploaded: [{ local, path, nodeId }], skipped, skippedHidden, failed: [{ local, path, message }] }`. Exit 1 means at least one file failed. To resume a stopped upload, run it again with `--skip-existing`: it asks `files/stat` first and sends only the paths that do not exist yet. Empty files are refused, because an upload needs at least 1 byte; use `files/touch` for an empty text file. `--overwrite replace` is the default. `--skip-processing` keeps text files as uploaded bytes instead of editable documents.

An uploaded file is `pending` until the server confirms its bytes. Until then `files/read` answers 404 for it, so a file you just replaced reads as missing for a few seconds. Add `--wait` to wait (up to 10 minutes) until every uploaded file is `ready`; files still not ready are listed in `pending`, with exit 1.

## 6. Look around and organize folders

```sh
node <skill folder>/scripts/api.mjs ls /Inbox --all
node <skill folder>/scripts/api.mjs stat /Inbox/a.md /Inbox/old
node <skill folder>/scripts/api.mjs mkdir /Projects/2026/Q1 /Projects/2026/Q2
node <skill folder>/scripts/api.mjs rm /Inbox/old /Inbox/tmp.md --wait
node <skill folder>/scripts/api.mjs restore /Inbox/old --wait
node <skill folder>/scripts/api.mjs mv /Inbox/a.md /Inbox/b.md /Projects/2026/Q1 --wait
node <skill folder>/scripts/api.mjs mv /Projects/2026/Q1/a.md /Projects/2026/Q1/notes.md --wait
node <skill folder>/scripts/api.mjs cp /Projects/2026/Q1 /Backup/2026/Q1 --parents --wait
```

- `ls [folder]` lists one page of 100. `--all` follows every page, `--recursive` walks the whole tree, and `--cursor` goes on from a page. A huge folder makes a huge `--all` answer, so page through it instead.
- `stat` answers each path as `found` (with the same details as `ls`), `missing`, or `denied`. Exit 1 when any path is not found.
- `mkdir` works like `mkdir -p`, all or nothing: one refused path makes no folder.
- `rm` archives files and folders, like `rm -r`. `restore` or the app Trash brings them back. It refuses a missing or locked path alone and deletes the rest. A big folder goes on in the background: `--wait` waits for the job, and `job <job id> --wait` reads it later. A key bound to a service account deletes only what the account itself may change.
- `restore` brings back deleted files and folders, with everything the same `rm` deleted with them. An item comes back where it was, or at the workspace root when its folder is gone. When an item with the same name is there, it comes back with a new name such as `notes-2.md` (`--on-conflict keep_both`, the default); `--on-conflict skip` leaves it deleted. Only the jobs name these items, so use `--wait` to see them: each job's `renamed` lists every item with its new path, and its `refused` lists the items that stayed deleted. Without `--wait`, read each job later with `job <job id>`. It takes at most 100 paths per call. If a job stops partway (for example Keep both found no free name), the job's `refused` names a path still in the Trash: fix the reason the job gives, then restore that path to bring back the rest. It refuses a path alone when nothing deleted is there, when the path was deleted more than once (restore that one in the app), or when it is locked. It prints `Request id: <id>` on stderr like `mv`; rerun with `--request-id <that id>` after a lost answer. `--wait` waits for every job. It needs a personal key with `files:write`; `--wait` and `job` need `files:list` too.
- `mv` and `cp` work like `mv` and `cp -r`. When the last path is an existing folder, the other paths go inside it. Otherwise there must be one path, and the last path is its new path: that is also how to rename. A new name must be clean, like in uploads ([upload](references/upload.md) step 2). A last path that ends with `/` must be an existing folder. Another path that ends with `/` must be a folder. The folder above a new path must exist; `--parents` makes it first. They refuse a missing or locked path alone and move or copy the rest. A file already at the destination stops a move (`--on-conflict error`, the default); a copy replaces it by default. `--on-conflict skip` keeps the existing file. Each call prints `Request id: <id>` on stderr before it sends anything. If the answer got lost, run the same command with `--request-id <that id>`: it returns the same job instead of starting a second one. `cp` needs a key with `files:read` and `files:download` too. A key bound to a service account moves and copies only what the account itself may read and change. A move that would make an item public needs `files:publish`. A move into, out of, or between restricted folders, or into a folder with added people, needs `files:permissions`. An item refused for a scope is listed in the job's `refused`, and the other items go on.

## 7. Log out

`logout` deletes the saved key file. It does not revoke the key. Tell the user to revoke it on the API keys page too.

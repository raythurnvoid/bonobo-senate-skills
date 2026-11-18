# Download a folder

From the installed skill folder, run:

```sh
node scripts/api.mjs download /notes --to ./notes
node scripts/api.mjs download-status --to ./notes
node scripts/api.mjs download /notes --to ./notes --resume
```

In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` so the shell passes the workspace path unchanged.

Use a personal or service account key with `files:list` and `files:download`. Run `status` to check the workspace before starting. A guest should start at the folder shared with them. The download copies its contents and empty folders into the destination.

The command shows progress and retries on stderr. Stdout holds one JSON result. Status reads the last local progress record, even offline. Keep the sibling `<destination>.bonobo-download` directory to resume. It holds private file names and error history. The `errors` field gives the full path to the JSON Lines log. Each line records a path, stage, time, attempt, code, message and whether a retry was planned. Where available it includes the HTTP status. Earlier attempts stay in the log after success.

Ctrl+C stops the copy. Resume with the same source path and destination. The command checks the live workspace, key identity, and root folder. It lists the tree again and checks local copies against their saved hashes. A rotated key for the same identity can resume. A missing local output can be copied again. An interrupted file starts from byte zero.

The copy preserves existing files. A local edit, an unrelated file in the way, a changed or replaced source, or a path that disappeared is reported. Use a fresh directory for a fresh copy. Use a directory you control, on a filesystem with hard links such as NTFS or ext4. The destination files and the sibling checkpoint must be on the same filesystem. For an external drive, choose a folder inside the drive. Resume on the same computer and operating system.

A download lists the live tree. Files added or moved behind its current position can be missed. Each file holds the saved bytes served when downloaded, at its path when listed. Other people can change or move files during a run. An editable file can return its previous saved version while a new version is being saved. A resume keeps verified copies and reports changes it observes. File timestamps cannot prove that the remote bytes are still the same. Locked entries are counted once and locked folders are never entered. Pending uploads can be retried after the upload finishes.

Counts describe the current scan. `saved` and `bytes` count new copies. `verified` counts intact local copies. If a cursor becomes unusable, the run reports a partial result. It keeps the files, counts and error log. Use `--resume` to scan again. At the end of a resume, `pathsChecked` shows progress while the CLI checks for paths that disappeared. The log keeps earlier attempts. If the whole run stops, `runError` gives the stage and reason, even when no individual file failed. Before a checkpoint exists, read stderr and the final result.

Exit 0 means the scan finished and every entry was handled. A partial result gives exit 1. Check `failed`, `denied`, `conflicts`, and the error log. A lost API connection gives exit 3. Missing credentials give exit 4.

The API signs up to 20 file links per call. It can issue up to 20 immediately and refills at 120 per minute, shared by this key's downloads. Each refused file also uses a slot. Multiple storage transfers can overlap. Even with a full starting allowance, 741 files take at least about six minutes to sign. Signed links live only in memory.

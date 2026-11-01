#!/usr/bin/env node
// Usage: node api.mjs <command> [options]. Run "node api.mjs help" for the list.
// Small Bonobo Senate public API client for agents and people on a PC. Node 22 or newer, no dependencies.
// Read references/setup.md in this skill folder before using it.
//
// Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 3 cannot reach the API or lost its answer, 4 no API key is set up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Messages name the script by its full path, so the user can run them from any folder.
const SCRIPT = `node "${fileURLToPath(import.meta.url)}"`;

// Keep this equal to metadata.version in ../SKILL.md, so a user can tell whether a copy is current.
// The skill test in the Bonobo Senate repo checks that the two match.
const VERSION = "1.1.4";

const USAGE = `Usage: node api.mjs <command> [options]. Workspace paths start with /. Skill version ${VERSION}.

Key:
  login --origin <api origin>     Read the key from stdin (a pipe or a hidden prompt), check it, save it.
  status                          Check the saved key. Prints the organization, workspace, and scopes.
  logout                          Delete the saved key file.

Files:
  ls [folder] [--recursive] [--all] [--cursor <c>]
                                  List a folder. --all follows every page.
  stat <path>... [--expect found|missing|denied]
                                  Say for each path: found (with its details), missing, or denied.
                                  Exit 0 when every path has the --expect status (default found), else 1.
  read <path> [--to <file>]       Write the saved bytes of a file to stdout, or to --to, following every page.
                                  Then print { path, contentType, revision, size, isLatest }: on stdout with
                                  --to, on stderr without. In PowerShell, use --to: before 7.4, > breaks bytes.
  write <path> --from <file | -> [--if-revision <revision>]
                                  Create a text file or replace its whole text. - reads stdin.
  mkdir <path>...                 Create folders and the folders above them, like mkdir -p. All or nothing.
  rm <path>... [--wait]           Move files and folders to Trash, like rm -r. restore brings them back.
  trash [--area <node id>] [--all] [--cursor <c>]
                                  List what is in Trash, newest delete first. --area lists inside one
                                  restricted folder. --all follows every page.
  restore <path>... [--on-conflict keep_both|skip] [--request-id <id>] [--wait] [--dry-run]
  restore --node <node id>:<archive operation id>... [same options]
                                  Bring back each item and the items inside it that were moved to Trash with it.
                                  --node picks one item from trash, also when several have one path.
                                  --dry-run says what would happen and changes nothing.
  mv <path>... <to> [--on-conflict error|replace|skip] [--parents] [--request-id <id>] [--wait]
                                  Move or rename, like mv. An existing folder <to> takes the paths inside it.
                                  Otherwise <to> is the new path of the one path. --parents makes the folder above <to>.
  cp <path>... <to> [--on-conflict error|replace|skip] [--parents] [--request-id <id>] [--wait]
                                  Copy, like cp -r. Folders merge into an existing folder of the same name.
  job <job id> [--wait]           Show a job that rm, restore, mv, or cp started. --wait waits until it ends.
  upload <local path>... --to <folder> [--overwrite replace|fail] [--skip-existing] [--include-hidden]
         [--skip-processing] [--wait] [--dry-run]
                                  Upload files and folders. A folder keeps its own name under --to.
                                  Hidden files and folders (names that start with ".") are skipped.
  edit <path> --old-file <file> --new-file <file> [--if-revision <revision>]
                                  Replace the one place in a text file that matches the old text.
  append <path> --from <file | -> [--if-revision <revision>]
                                  Add text at the end of a text file. No newline is added. - reads stdin.
                                  write, edit, and append read local files as UTF-8 and send every byte unchanged.
                                  --if-revision takes the revision from your last read. The change then
                                  fails if the file changed since. Send it when you may run the command
                                  again: a second run without it can append twice.

Any route:
  call <route> [json | - | --body-file <file>] [--out <file>]
                                  POST one route, for example: call files/list '{"path":"/"}'
                                  Use - to read the JSON body from stdin. --out saves a raw byte answer.

Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 3 cannot reach the API or lost its answer, 4 no API key is set up.`;

// Keep the key in the home folder, not in this skill folder and not in AppData.
// A reinstall of the skill replaces its folder, which would delete the key.
// Packaged Windows apps (such as the Claude desktop app) get a private copy of AppData,
// so a key saved there by an agent could be invisible to the user's own terminal.
const CREDENTIALS_PATH = path.join(
	process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
	"bonobo-senate",
	"credentials.json",
);

const KEY_PATTERN = /^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u;

// The server accepts at most 20 files per upload-urls call.
const UPLOAD_BATCH_SIZE = 20;

// Keep a few PUTs in flight. Each one holds its whole file in memory.
const UPLOAD_CONCURRENCY = 4;

// The server answers at most 100 paths per files/stat call.
const STAT_BATCH_SIZE = 100;

// How often --wait asks again, and how long it waits before it gives up.
const WAIT_POLL_MS = 2000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;

// A job in one of these states can still change.
const ACTIVE_JOB_STATUSES = ["queued", "running", "stopping", "awaiting_input"];

// Keep the text rows equal to FILES_CONTENT_TYPE_HINT_BY_EXTENSION in packages/app/shared/files.ts.
// The server turns an upload with one of these types into an editable text file.
const CONTENT_TYPES = {
	".md": "text/markdown",
	".txt": "text/plain",
	".log": "text/plain",
	".ini": "text/plain",
	".html": "text/html",
	".htm": "text/html",
	".json": "application/json",
	".jsonc": "application/json",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".toml": "application/toml",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".cjs": "text/javascript",
	".jsx": "text/javascript",
	".ts": "text/typescript",
	".tsx": "text/typescript",
	".sh": "application/x-sh",
	".sql": "application/sql",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".zip": "application/zip",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

class UsageError extends Error {}

class NoKeyError extends Error {}

/**
 * The request did not reach the API: no network, a sandbox allowlist, or a wrong origin. The key may be fine.
 * It also means the answer was lost after it started to arrive. Then the request may have run.
 */
class NetworkError extends Error {}

/**
 * A route answered with an error. The main block prints the message and the JSON body.
 */
class ApiError extends Error {
	constructor(result) {
		super(describe_error(result));
		this.json = result.json;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// #region credentials
function load_credentials() {
	// An env key wins over the saved file, the same way GH_TOKEN wins in the gh CLI.
	if (process.env.T3_API_KEY) {
		if (!process.env.T3_API_ORIGIN) {
			throw new UsageError("T3_API_KEY is set, but T3_API_ORIGIN is not. Set both, or unset T3_API_KEY.");
		}
		return { source: "env", origin: check_origin(process.env.T3_API_ORIGIN), key: process.env.T3_API_KEY };
	}

	if (!fs.existsSync(CREDENTIALS_PATH)) {
		throw new NoKeyError(
			`No API key is set up. Ask the user to run this in their own terminal: ${SCRIPT} login --origin <api origin>. See references/setup.md.`,
		);
	}
	// Do not let a JSON error message quote the start of the file, which holds the key.
	let saved;
	try {
		saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
	} catch {
		saved = null;
	}
	if (typeof saved?.origin !== "string" || typeof saved?.key !== "string") {
		throw new NoKeyError(`The key file is damaged: ${CREDENTIALS_PATH}. Run login again.`);
	}
	return { source: "file", origin: saved.origin, key: saved.key };
}

function check_origin(origin) {
	let url;
	try {
		url = new URL(origin);
	} catch {
		throw new UsageError(`Not a valid URL: ${origin}`);
	}

	// Send the key only over HTTPS. Plain HTTP is fine only for a local server.
	const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
		throw new UsageError(`The API origin must use https: ${origin}`);
	}
	return url.origin;
}

function read_hidden(prompt) {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		let value = "";

		const finish = () => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
		};
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					resolve(value);
					return;
				}
				// Ctrl+C
				if (char === "\u0003") {
					finish();
					reject(new UsageError("Canceled"));
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
				} else {
					value += char;
				}
			}
		};

		process.stderr.write(prompt);
		stdin.setRawMode(true);
		stdin.setEncoding("utf8");
		stdin.resume();
		stdin.on("data", onData);
	});
}

async function read_stdin_bytes() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks);
}

async function read_stdin() {
	// Windows PowerShell puts a UTF-8 BOM in front of text it pipes to a program. JSON.parse refuses it.
	return (await read_stdin_bytes()).toString("utf8").replace(/^﻿/u, "");
}

/**
 * Read a local file, or stdin for "-", as strict UTF-8. Keep every byte, including a leading BOM.
 */
async function read_utf8_text(file) {
	// A local mistake is a usage error (exit 2). Exit 1 would say that the API refused something.
	if (file !== "-" && !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
		throw new UsageError(`Local file not found: ${file}`);
	}
	let bytes;
	try {
		bytes = file === "-" ? await read_stdin_bytes() : fs.readFileSync(file);
	} catch (error) {
		// The file check above passes for a file that another program holds open. Windows then refuses
		// the read (EBUSY). That is a local mistake too.
		if (!["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
		throw new UsageError(`Cannot read ${file} (${error.code}). Close the program that holds it open, or check that you may read it.`);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new UsageError(`Not valid UTF-8 text: ${file}. Use upload for binary files.`);
	}
}
// #endregion credentials

// #region requests
async function post(credentials, route, body) {
	const routePath = route.startsWith("/api/v1/") ? route : `/api/v1/${route.replace(/^\/+/u, "")}`;
	const response = await fetch(new URL(routePath, credentials.origin), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.key}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: "error",
	}).catch((error) => {
		// A failed connect can have an empty cause message and only a code such as ETIMEDOUT.
		throw new NetworkError(
			`Cannot reach ${credentials.origin}: ${error.cause?.message || error.cause?.code || error.message}. Check the network and any sandbox network allowlist. The key may be fine.`,
		);
	});

	const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
	// The answer can break after its headers arrived. The request may have run, so report it like a
	// lost connection.
	let bytes;
	let json;
	try {
		bytes = Buffer.from(await response.arrayBuffer());
		json = isJson ? JSON.parse(bytes.toString("utf8")) : null;
	} catch (error) {
		throw new NetworkError(`Lost the answer from ${credentials.origin}: ${error.message}.`);
	}
	return {
		status: response.status,
		ok: response.ok,
		isJson,
		bytes,
		json,
		// files/read describes the saved file here. A next cursor continues the read.
		fileHeaders: Object.fromEntries([...response.headers].filter(([name]) => name.startsWith("x-file-"))),
	};
}

// Wait and retry when the server says the rate limit is reached. Other errors return at once.
async function post_with_retry(credentials, route, body) {
	for (let attempt = 1; ; attempt++) {
		const result = await post(credentials, route, body);
		if (result.status !== 429 || attempt === 5) return result;

		const waitMs = result.json?.retryAfterMs ?? 2000;
		process.stderr.write(`Rate limited on ${route}. Waiting ${Math.ceil(waitMs / 1000)}s.\n`);
		await sleep(waitMs);
	}
}

function describe_error(result) {
	return `HTTP ${result.status}: ${result.json?.message ?? result.bytes.toString("utf8").slice(0, 500)}`;
}

// POST with retry, and throw on an error answer.
async function post_json(credentials, route, body) {
	const result = await post_with_retry(credentials, route, body);
	if (!result.ok) throw new ApiError(result);
	return result.json;
}

function print_json(value) {
	console.log(JSON.stringify(value, null, 2));
}

function check_workspace_paths(paths) {
	if (paths.length === 0) throw new UsageError(`Give at least one workspace path.\n\n${USAGE}`);
	for (const workspacePath of paths) {
		if (!workspacePath.startsWith("/")) {
			throw new UsageError(
				`Workspace paths start with /: ${workspacePath}. In Git Bash on Windows, set MSYS_NO_PATHCONV=1 first.`,
			);
		}
	}
}

async function stat_paths(credentials, paths) {
	const items = [];
	for (let start = 0; start < paths.length; start += STAT_BATCH_SIZE) {
		const result = await post_json(credentials, "files/stat", { paths: paths.slice(start, start + STAT_BATCH_SIZE) });
		items.push(...result.items);
	}
	return items;
}

async function wait_for_job(credentials, jobId) {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (true) {
		const job = await post_json(credentials, "files/jobs/get", { jobId });
		if (!ACTIVE_JOB_STATUSES.includes(job.status) || Date.now() > deadline) return await read_all_refused(credentials, job);
		await sleep(WAIT_POLL_MS);
	}
}

// A job returns its refused and renamed items a page at a time. Read the other pages too.
async function read_all_refused(credentials, job) {
	const refused = [...job.refused];
	const renamed = [...job.renamed];
	for (let cursor = job.refusedCursor; cursor; ) {
		const page = await post_json(credentials, "files/jobs/get", { jobId: job.jobId, cursor });
		refused.push(...page.refused);
		renamed.push(...page.renamed);
		cursor = page.refusedCursor;
	}
	return { ...job, refused, renamed, refusedCursor: null };
}
// #endregion requests

// #region commands
async function command_login(args) {
	const { values } = parseArgs({ args, options: { origin: { type: "string" } } });
	if (!values.origin) {
		throw new UsageError(
			`--origin is required. Copy it from the "Use an API key" section of the API keys page (the T3_API_ORIGIN value).`,
		);
	}
	const origin = check_origin(values.origin);

	const typed = process.stdin.isTTY ? await read_hidden("Paste the API key (it stays hidden): ") : await read_stdin();
	// Terminals can wrap a paste in bracketed-paste markers. Drop them.
	const key = typed.replace(/\u001b\[20[01]~/gu, "").trim();
	if (!KEY_PATTERN.test(key)) {
		throw new UsageError("That is not an API key. A key looks like pk_<32 hex>.<64 hex>.");
	}

	const verified = await post({ origin, key }, "auth/verify");
	if (!verified.ok) {
		throw new Error(`The key was not saved. ${describe_error(verified)}`);
	}

	fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
	fs.writeFileSync(CREDENTIALS_PATH, `${JSON.stringify({ origin, key }, null, "\t")}\n`, { mode: 0o600 });
	// writeFileSync keeps the mode of an existing file, so set it again.
	fs.chmodSync(CREDENTIALS_PATH, 0o600);

	console.log(JSON.stringify({ saved: CREDENTIALS_PATH, origin, ...verified.json }, null, 2));
}

async function command_status() {
	const credentials = load_credentials();
	const verified = await post(credentials, "auth/verify");
	if (!verified.ok) {
		const keyName = credentials.source === "env" ? "T3_API_KEY" : "saved";
		// Only a 401 means the key itself is bad. A 429 or a server error passes with time.
		throw new Error(
			verified.status === 401
				? `The ${keyName} key does not work: it is wrong, revoked, or its membership ended. Ask the user for a new key. ${describe_error(verified)}`
				: `The ${keyName} key could not be checked. Try again later. ${describe_error(verified)}`,
		);
	}

	console.log(
		JSON.stringify(
			{
				version: VERSION,
				source: credentials.source,
				...(credentials.source === "file" ? { path: CREDENTIALS_PATH } : {}),
				origin: credentials.origin,
				...verified.json,
			},
			null,
			2,
		),
	);
}

function command_logout() {
	if (!fs.existsSync(CREDENTIALS_PATH)) {
		console.log(JSON.stringify({ deleted: null }));
		return;
	}
	fs.rmSync(CREDENTIALS_PATH);
	// Deleting the file does not revoke the key. Revoke it on the API keys page too.
	console.log(JSON.stringify({ deleted: CREDENTIALS_PATH, note: "The key still works until you revoke it on the API keys page." }));
}

async function command_call(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { "body-file": { type: "string" }, out: { type: "string" } },
	});
	const [route, bodyArg, ...extra] = positionals;
	if (!route || extra.length > 0 || (bodyArg !== undefined && values["body-file"])) throw new UsageError(USAGE);

	let body;
	// A file avoids shell quoting, and Windows PowerShell 5.1 pipes turn non-ASCII text into "?".
	const text = values["body-file"]
		? fs.readFileSync(values["body-file"], "utf8").replace(/^﻿/u, "")
		: bodyArg === "-"
			? await read_stdin()
			: bodyArg;
	if (text !== undefined) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new UsageError("The request body is not valid JSON.");
		}
	}

	const result = await post_with_retry(load_credentials(), route, body);
	if (!result.ok) {
		process.stderr.write(`${describe_error(result)}\n`);
		if (result.json) process.stderr.write(`${JSON.stringify(result.json)}\n`);
		return 1;
	}

	// JSON goes out readable. Raw bytes (files/read) go out unchanged, with their file headers on stderr.
	if (result.isJson) {
		console.log(JSON.stringify(result.json, null, 2));
	} else {
		process.stderr.write(`${JSON.stringify(result.fileHeaders)}\n`);
		// Windows PowerShell 5.1 turns bytes redirected with > into text, so --out writes the file itself.
		if (values.out) fs.writeFileSync(values.out, result.bytes);
		else process.stdout.write(result.bytes);
	}
	return 0;
}

async function command_ls(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { recursive: { type: "boolean" }, all: { type: "boolean" }, cursor: { type: "string" } },
	});
	if (positionals.length > 1) throw new UsageError(`Give one folder.\n\n${USAGE}`);
	const folder = positionals[0] ?? "/";
	check_workspace_paths([folder]);

	const credentials = load_credentials();
	const items = [];
	let cursor = values.cursor ?? null;
	while (true) {
		const page = await post_json(credentials, "files/list", {
			path: folder,
			recursive: values.recursive ?? false,
			limit: 100,
			cursor,
		});
		items.push(...page.items);
		cursor = page.isDone ? null : page.cursor;
		if (!values.all || page.isDone) break;
	}
	print_json({ items, cursor, isDone: cursor === null });
}

async function command_stat(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { expect: { type: "string" } } });
	const expected = values.expect ?? "found";
	// Use the status words of the output, so a script can copy the word it sees.
	if (!["found", "missing", "denied"].includes(expected)) {
		throw new UsageError(`--expect must be found, missing, or denied, not: ${expected}`);
	}
	check_workspace_paths(positionals);
	const items = await stat_paths(load_credentials(), positionals);
	print_json({ items });
	return items.every((item) => item.status === expected) ? 0 : 1;
}

async function command_mkdir(args) {
	const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
	check_workspace_paths(positionals);
	print_json(await post_json(load_credentials(), "files/mkdir", { paths: positionals }));
}

async function command_rm(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "boolean" } } });
	check_workspace_paths(positionals);

	const credentials = load_credentials();
	const deleted = await post_json(credentials, "files/delete", { paths: positionals });
	// A job that ends later can still refuse items inside a folder. Read them from the job.
	const job = values.wait && deleted.jobId && !deleted.isDone ? await wait_for_job(credentials, deleted.jobId) : null;
	print_json({ ...deleted, ...(job ? { job } : {}) });
	return deleted.refused.length > 0 || (job && job.status !== "succeeded") ? 1 : 0;
}

async function command_trash(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: { area: { type: "string" }, all: { type: "boolean" }, cursor: { type: "string" } },
	});
	if (positionals.length > 0) throw new UsageError(`trash takes no paths. Use --area <node id>.\n\n${USAGE}`);

	const credentials = load_credentials();
	const items = [];
	let cursor = values.cursor ?? null;
	while (true) {
		const page = await post_json(credentials, "files/trash/list", { areaNodeId: values.area ?? null, cursor });
		items.push(...page.items);
		cursor = page.cursor;
		if (!values.all || cursor === null) break;
	}
	print_json({ items, cursor, isDone: cursor === null });
}

async function command_restore(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			node: { type: "string", multiple: true },
			"on-conflict": { type: "string" },
			"request-id": { type: "string" },
			wait: { type: "boolean" },
			"dry-run": { type: "boolean" },
		},
	});
	// Take paths or --node, like the route: never both.
	const nodes = (values.node ?? []).map((value) => {
		const [nodeId, archiveOperationId, ...rest] = value.split(":");
		if (!nodeId || !archiveOperationId || rest.length > 0) {
			throw new UsageError(`--node must be <node id>:<archive operation id> from trash, not: ${value}`);
		}
		return { nodeId, archiveOperationId };
	});
	if (nodes.length > 0 && positionals.length > 0) throw new UsageError("Give paths or --node, not both.");
	if (nodes.length === 0) check_workspace_paths(positionals);
	const onConflict = values["on-conflict"];
	if (onConflict !== undefined && !["keep_both", "skip"].includes(onConflict)) {
		throw new UsageError("--on-conflict must be keep_both or skip.");
	}
	// A dry run saves nothing, so it has no request id and no job to wait for.
	if (values["dry-run"] && (values.wait || values["request-id"] !== undefined)) {
		throw new UsageError("--dry-run takes no --wait and no --request-id.");
	}
	const selection = nodes.length > 0 ? { nodes } : { paths: positionals };

	const credentials = load_credentials();
	if (values["dry-run"]) {
		const preview = await post_json(credentials, "files/restore", {
			...selection,
			...(onConflict ? { onConflict } : {}),
			dryRun: true,
		});
		print_json(preview);
		// A job can succeed and still leave items in the Trash, for example with --on-conflict skip.
		return preview.refused.length > 0 ||
			preview.jobs.some((job) => job.status !== "succeeded" || job.refused.length > 0)
			? 1
			: 0;
	}
	// The same request id returns the same jobs, so a rerun after a lost answer does not restore twice.
	// Print it before the call, so it is there even when the answer is lost.
	const requestId = values["request-id"] ?? crypto.randomUUID();
	process.stderr.write(`Request id: ${requestId}\n`);
	const restored = await post_json(credentials, "files/restore", {
		...selection,
		...(onConflict ? { onConflict } : {}),
		requestId,
	});
	// One job for each delete the paths came from. The jobs run one after another. Only the jobs name the
	// items that came back with a new name or stayed in the Trash. Read them only with --wait: jobs/get
	// needs files:list, and restore alone needs only files:write.
	const jobs = [];
	if (values.wait) for (const jobId of restored.jobIds) jobs.push(await wait_for_job(credentials, jobId));
	print_json({ requestId, ...restored, ...(values.wait ? { jobs } : {}) });
	return restored.refused.length > 0 || jobs.some((job) => job.status !== "succeeded" || job.refused.length > 0)
		? 1
		: 0;
}

async function command_transfer(kind, args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			"on-conflict": { type: "string" },
			parents: { type: "boolean" },
			"request-id": { type: "string" },
			wait: { type: "boolean" },
		},
	});
	if (positionals.length < 2) throw new UsageError(`Give at least one path and a destination.\n\n${USAGE}`);
	check_workspace_paths(positionals);
	const onConflict = values["on-conflict"];
	if (onConflict !== undefined && !["error", "replace", "skip"].includes(onConflict)) {
		throw new UsageError("--on-conflict must be error, replace, or skip.");
	}
	// A trailing "/" stays, like in mv: it says <to> must be an existing folder.
	const to = positionals.at(-1);
	const toPath = to.replace(/(?<=.)\/+$/u, "");

	const credentials = load_credentials();
	// The server makes no missing folders for a move or a copy. mkdir is fine with a folder that exists.
	const folderToMake = toPath !== to ? toPath : toPath.slice(0, toPath.lastIndexOf("/"));
	if (values.parents && folderToMake) await post_json(credentials, "files/mkdir", { paths: [folderToMake] });

	// The same request id returns the same job, so a rerun after a lost answer does not move twice.
	// Print it before the call, so it is there even when the answer is lost.
	const requestId = values["request-id"] ?? crypto.randomUUID();
	process.stderr.write(`Request id: ${requestId}\n`);
	const started = await post_json(credentials, `files/${kind}`, {
		from: positionals.slice(0, -1),
		to,
		...(onConflict ? { onConflict } : {}),
		requestId,
	});
	// A rerun of a finished job answers isDone: true, so read the job anyway to show how it ended.
	const job = values.wait && started.jobId ? await wait_for_job(credentials, started.jobId) : null;
	print_json({ requestId, ...started, ...(job ? { job } : {}) });
	return started.refused.length > 0 || (job && (job.status !== "succeeded" || job.refused.length > 0)) ? 1 : 0;
}

async function command_job(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "boolean" } } });
	if (positionals.length !== 1) throw new UsageError(`Give one job id.\n\n${USAGE}`);

	const credentials = load_credentials();
	const job = values.wait
		? await wait_for_job(credentials, positionals[0])
		: await read_all_refused(credentials, await post_json(credentials, "files/jobs/get", { jobId: positionals[0] }));
	print_json(job);
	return ACTIVE_JOB_STATUSES.includes(job.status) || job.status === "succeeded" ? 0 : 1;
}

async function command_upload(args) {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			to: { type: "string" },
			overwrite: { type: "string" },
			"skip-existing": { type: "boolean" },
			"include-hidden": { type: "boolean" },
			"skip-processing": { type: "boolean" },
			wait: { type: "boolean" },
			"dry-run": { type: "boolean" },
		},
	});
	if (positionals.length === 0 || !values.to?.startsWith("/")) {
		throw new UsageError(`Give at least one local path and --to /<workspace folder>.\n\n${USAGE}`);
	}
	if (values.overwrite !== undefined && values.overwrite !== "replace" && values.overwrite !== "fail") {
		throw new UsageError("--overwrite must be replace or fail.");
	}

	// Build the list of files. A folder keeps its own name under --to, like "cp -R folder dest".
	const items = [];
	const skipped = [];
	const failed = [];
	let hiddenCount = 0;
	const remoteRoot = values.to.replace(/\/+$/u, "");
	for (const localArg of positionals) {
		const localRoot = path.resolve(localArg);
		const stat = fs.statSync(localRoot, { throwIfNoEntry: false });
		if (!stat) {
			failed.push({ local: localRoot, path: null, message: "Local path not found" });
			continue;
		}

		const files = [];
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(localRoot, { recursive: true, withFileTypes: true })) {
				const local = path.join(entry.parentPath, entry.name);
				// Skip .git, .env, and other hidden files and folders unless asked. They are rarely meant for the workspace.
				if (!values["include-hidden"] && path.relative(localRoot, local).split(path.sep).some((name) => name.startsWith("."))) {
					if (entry.isFile()) hiddenCount += 1;
					continue;
				}
				if (entry.isSymbolicLink()) {
					skipped.push({ local, path: null, message: "Symbolic link. Upload the file or folder it points to instead." });
				} else if (entry.isFile()) {
					files.push(local);
				}
			}
		} else {
			files.push(localRoot);
		}
		for (const local of files) {
			const relative = path.relative(path.dirname(localRoot), local).split(path.sep).join("/");
			const size = fs.statSync(local).size;
			const item = {
				local,
				path: `${remoteRoot}/${relative}`,
				contentType: CONTENT_TYPES[path.extname(local).toLowerCase()] ?? "application/octet-stream",
				size,
			};
			if (size === 0) {
				failed.push({ ...item, message: "Empty file. An upload needs at least 1 byte. Use files/touch for an empty text file." });
			} else {
				items.push(item);
			}
		}
	}

	if (values["dry-run"]) {
		print_json({ wouldUpload: items, skipped, skippedHidden: hiddenCount, failed });
		return failed.length > 0 ? 1 : 0;
	}

	const credentials = load_credentials();

	// A rerun after a stop sends only what is not there yet.
	if (values["skip-existing"]) {
		const found = new Set(
			(await stat_paths(credentials, items.map((item) => item.path)))
				.filter((result) => result.status === "found")
				.map((result) => result.path),
		);
		for (const item of items.filter((item) => found.has(item.path))) skipped.push({ ...item, message: "Already exists" });
		items.splice(0, items.length, ...items.filter((item) => !found.has(item.path)));
	}

	const uploaded = [];
	let stopMessage = null;
	const batches = [];
	for (let start = 0; start < items.length; start += UPLOAD_BATCH_SIZE) {
		batches.push(items.slice(start, start + UPLOAD_BATCH_SIZE));
	}
	for (let batch = batches.shift(); batch; batch = batches.shift()) {
		// After a refusal that hits every file, the later batches would fail the same way.
		if (stopMessage) {
			for (const item of batch) failed.push({ ...item, message: stopMessage });
			continue;
		}

		// The server checks the whole batch before it writes anything, and it names the path it refused.
		// Keep what worked: drop that one file and ask again for the rest.
		let targets = null;
		while (batch.length > 0) {
			const result = await post_with_retry(credentials, "files/upload-urls", {
				files: batch.map(({ path, contentType, size }) => ({ path, contentType, size })),
				overwrite: values.overwrite,
				skipProcessing: values["skip-processing"],
			});
			if (result.ok) {
				targets = result.json.files;
				break;
			}

			// The folder limit counts the whole batch, not the named file. Send the batch in two halves.
			if (result.json?.code === "too_many_folders" && batch.length > 1) {
				const half = Math.ceil(batch.length / 2);
				batches.unshift(batch.slice(0, half), batch.slice(half));
				batch = [];
				break;
			}

			// A refusal without a path (a bad key, no upload plan, a rate limit that did not clear) hits every file.
			const refused = batch.find((item) => item.path === result.json?.path);
			if (!refused || result.status === 401 || result.status === 429) {
				stopMessage = describe_error(result);
				for (const item of batch) failed.push({ ...item, message: stopMessage });
				batch = [];
				break;
			}
			failed.push({ ...refused, message: describe_error(result) });
			batch = batch.filter((item) => item !== refused);
		}
		if (!targets) continue;

		const queue = targets.map((target, index) => ({ target, item: batch[index] }));
		await Promise.all(
			Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
				for (let next = queue.shift(); next; next = queue.shift()) {
					const { target, item } = next;
					// A file that cannot be read now (another program holds it open, or it was deleted after the
					// list was made) fails alone like a failed PUT. A throw here would lose the report of the
					// files that worked.
					const body = await fs.promises.readFile(item.local).catch((error) => error);
					if (body instanceof Error) {
						failed.push({
							...item,
							message: `Cannot read the local file (${body.code ?? body.message}). Close the program that holds it open, or check that it still exists.`,
						});
						process.stderr.write(`Failed ${target.path}\n`);
						continue;
					}
					const put = () =>
						fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body }).catch((error) => ({
							ok: false,
							status: 0,
							// The bytes go to a storage host, not the API origin. A sandbox allowlist needs this host too.
							statusText: `cannot reach ${new URL(target.uploadUrl).host}: ${error.cause?.message || error.cause?.code || error.message}`,
						}));
					let response = await put();
					// Try once more after a network error or a storage hiccup.
					if (!response.ok && (response.status === 0 || response.status >= 500)) response = await put();

					if (response.ok) {
						uploaded.push({ local: item.local, path: target.path, nodeId: target.nodeId });
						process.stderr.write(`Uploaded ${target.path}\n`);
					} else {
						failed.push({ ...item, message: `Upload PUT failed: ${response.status} ${response.statusText}` });
						process.stderr.write(`Failed ${target.path}\n`);
					}
				}
			}),
		);
	}

	// An accepted upload is not ready yet. The server confirms it later, and files/stat then shows status "ready".
	let pending = [];
	if (values.wait) {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		pending = uploaded.map((item) => item.path);
		while (pending.length > 0 && Date.now() < deadline) {
			const ready = new Set(
				(await stat_paths(credentials, pending))
					.filter((result) => result.status === "found" && result.item.status === "ready")
					.map((result) => result.path),
			);
			pending = pending.filter((uploadedPath) => !ready.has(uploadedPath));
			if (pending.length > 0) await sleep(WAIT_POLL_MS);
		}
	}

	print_json({ uploaded, skipped, skippedHidden: hiddenCount, failed, ...(values.wait ? { pending } : {}) });
	return failed.length > 0 || pending.length > 0 ? 1 : 0;
}

async function command_read(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { to: { type: "string" } } });
	if (positionals.length !== 1) throw new UsageError(`Give one workspace path.\n\n${USAGE}`);
	check_workspace_paths(positionals);
	const target = values.to;

	// lstat also sees a link whose target is gone.
	if (target !== undefined) {
		const stats = fs.lstatSync(target, { throwIfNoEntry: false });
		if (stats?.isDirectory() || stats?.isSymbolicLink()) {
			throw new UsageError(`--to must name a file, not a folder or a link: ${target}`);
		}
		const folder = path.dirname(path.resolve(target));
		if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
			throw new UsageError(`Local folder not found: ${folder}`);
		}
	}
	const credentials = load_credentials();

	// With --to, write a new file next to the target and rename it at the end, so a failed read keeps
	// the old file. "wx" refuses to open a file that is already there, so the CLI only ever deletes
	// its own file.
	const tempPath = target === undefined ? null : `${target}.${crypto.randomUUID().slice(0, 8)}.part`;
	let tempFd = tempPath === null ? null : fs.openSync(tempPath, "wx");

	// The write callback alone misses an error that comes later, such as a closed pipe (EPIPE after
	// "| head"). Without a listener, that error event would crash the process with a stack trace.
	let stdoutError = null;
	if (tempFd === null) process.stdout.on("error", (error) => (stdoutError ??= error));
	let wroteStdout = false;

	let facts = null;
	try {
		let cursor = null;
		do {
			const result = await post_with_retry(credentials, "files/read", { path: positionals[0], cursor });
			if (!result.ok) throw new ApiError(result);

			const headers = result.fileHeaders;
			facts ??= {
				path: positionals[0],
				contentType: headers["x-file-content-type"],
				revision: headers["x-file-revision"],
				size: Number(headers["x-file-size"]),
				isLatest: headers["x-file-is-latest"] === "true",
			};

			if (tempFd !== null) {
				fs.writeFileSync(tempFd, result.bytes);
			} else if (result.bytes.length > 0) {
				// Wait until stdout took the page before asking for the next one, so a slow reader
				// cannot pile up pages in memory.
				wroteStdout = true;
				await new Promise((resolve, reject) =>
					process.stdout.write(result.bytes, (error) => (error ? reject(error) : resolve())),
				).catch((error) => {
					stdoutError ??= error;
				});
				if (stdoutError) throw new Error(`Cannot write to stdout: ${stdoutError.message}.`);
			}

			cursor = headers["x-file-next-cursor"] ?? null;
		} while (cursor !== null);

		if (tempFd !== null) {
			fs.closeSync(tempFd);
			tempFd = null;
			try {
				fs.renameSync(tempPath, target);
			} catch (error) {
				// Windows refuses to replace a file that another program holds open.
				throw ["EPERM", "EBUSY", "EACCES"].includes(error.code)
					? new Error(
							`Cannot replace ${target} (${error.code}). Close the program that holds it open, or pick another --to file.`,
						)
					: error;
			}
		}
	} catch (error) {
		if (tempPath !== null) {
			if (tempFd !== null) fs.closeSync(tempFd);
			fs.rmSync(tempPath, { force: true });
		} else if (wroteStdout && !stdoutError) {
			// The bytes already sent cannot be taken back.
			error.message += " The output is incomplete. Discard it and run the command again.";
		}
		throw error;
	}

	if (!facts.isLatest) {
		process.stderr.write(
			"Note: someone is typing in this file. The saved text does not have their change yet, and a write with this revision is refused (file_not_latest) until it does.\n",
		);
	}
	// stdout holds the bytes when there is no --to. Then the facts go to stderr, like the headers of call.
	if (target !== undefined) print_json(facts);
	else process.stderr.write(`${JSON.stringify(facts)}\n`);
	return 0;
}

async function command_change(kind, args) {
	const isEdit = kind === "edit";
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			...(isEdit
				? { "old-file": { type: "string" }, "new-file": { type: "string" } }
				: { from: { type: "string" } }),
			"if-revision": { type: "string" },
		},
	});
	if (positionals.length !== 1 || (isEdit ? !values["old-file"] || !values["new-file"] : !values.from)) {
		throw new UsageError(
			`Give one workspace path and ${isEdit ? "--old-file and --new-file" : "--from"}.\n\n${USAGE}`,
		);
	}
	check_workspace_paths(positionals);
	const body = {
		path: positionals[0],
		...(isEdit
			? { oldText: await read_utf8_text(values["old-file"]), newText: await read_utf8_text(values["new-file"]) }
			: { content: await read_utf8_text(values.from) }),
		...(values["if-revision"] !== undefined ? { expectedRevision: values["if-revision"] } : {}),
	};

	// Never send the change again by itself. After a lost answer it may already be saved, and an append
	// would then happen twice. post_with_retry only waits and retries on 429, which saves nothing.
	const result = await post_with_retry(load_credentials(), `files/${kind}`, body).catch((error) => {
		if (error instanceof NetworkError) {
			throw new NetworkError(`${error.message} The ${kind} may be saved. Read the file before you run it again.`);
		}
		throw error;
	});
	if (!result.ok) {
		const error = new ApiError(result);
		// Only these refusals can succeed after a new read. file_changed and file_not_latest already say
		// what to do, and running again does not help for others, such as file_needs_repair or Read-only.
		if (result.status === 409 && ["file_busy", "text_not_found", "text_not_unique"].includes(result.json?.errorCode)) {
			error.message += " Read the file and run the command again.";
		}
		throw error;
	}

	if (result.json.contentChanged) {
		process.stderr.write(
			"Note: the saved text is not exactly what you sent. Line endings became LF, a leading BOM was removed, or it holds someone's unsaved typing in the editor's format. Read the file to check.\n",
		);
	}
	print_json(result.json);
	return 0;
}
// #endregion commands

const [command, ...rest] = process.argv.slice(2);
const commands = {
	login: command_login,
	status: command_status,
	logout: command_logout,
	ls: command_ls,
	stat: command_stat,
	mkdir: command_mkdir,
	rm: command_rm,
	trash: command_trash,
	restore: command_restore,
	mv: (args) => command_transfer("move", args),
	cp: (args) => command_transfer("copy", args),
	job: command_job,
	upload: command_upload,
	read: command_read,
	write: (args) => command_change("write", args),
	edit: (args) => command_change("edit", args),
	append: (args) => command_change("append", args),
	call: command_call,
};

try {
	if (command === undefined || command === "help" || rest.includes("--help") || rest.includes("-h") || command === "--help") {
		console.log(USAGE);
	} else {
		if (!commands[command]) throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`);
		process.exitCode = (await commands[command](rest)) ?? 0;
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	if (error instanceof ApiError && error.json) process.stderr.write(`${JSON.stringify(error.json)}\n`);
	// parseArgs throws a TypeError with an ERR_PARSE_ARGS_* code for an unknown or bad option.
	const isUsage = error instanceof UsageError || String(error?.code ?? "").startsWith("ERR_PARSE_ARGS");
	process.exitCode = isUsage ? 2 : error instanceof NetworkError ? 3 : error instanceof NoKeyError ? 4 : 1;
}

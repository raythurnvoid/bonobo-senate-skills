#!/usr/bin/env node
// Usage: node api.mjs <command> [options]. Run "node api.mjs help" for the list.
// Small Bonobo Senate public API client for agents and people on a PC. Node 22 or newer, no dependencies.
// Read references/setup.md in this skill folder before using it.
//
// Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 3 cannot reach the API, 4 no API key is set up.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Messages name the script by its full path, so the user can run them from any folder.
const SCRIPT = `node "${fileURLToPath(import.meta.url)}"`;

const USAGE = `Usage: node api.mjs <command> [options]. Workspace paths start with /.

Key:
  login --origin <api origin>     Read the key from stdin (a pipe or a hidden prompt), check it, save it.
  status                          Check the saved key. Prints the organization, workspace, and scopes.
  logout                          Delete the saved key file.

Files:
  ls [folder] [--recursive] [--all] [--cursor <c>]
                                  List a folder. --all follows every page.
  stat <path>...                  Say for each path: found (with its details), missing, or denied.
  mkdir <path>...                 Create folders and the folders above them, like mkdir -p. All or nothing.
  rm <path>... [--wait]           Delete (archive) files and folders, like rm -r. The app Trash can restore them.
  job <job id> [--wait]           Show a job that rm started. --wait waits until it ends.
  upload <local path>... --to <folder> [--overwrite replace|fail] [--skip-existing] [--include-hidden]
         [--skip-processing] [--wait] [--dry-run]
                                  Upload files and folders. A folder keeps its own name under --to.
                                  Hidden files and folders (names that start with ".") are skipped.

Any route:
  call <route> [json | - | --body-file <file>] [--out <file>]
                                  POST one route, for example: call files/list '{"path":"/"}'
                                  Use - to read the JSON body from stdin. --out saves a raw byte answer.

Exit codes: 0 ok, 1 the API or an upload failed, 2 usage error, 3 cannot reach the API, 4 no API key is set up.`;

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

async function read_stdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	// Windows PowerShell puts a UTF-8 BOM in front of text it pipes to a program. JSON.parse refuses it.
	return Buffer.concat(chunks).toString("utf8").replace(/^﻿/u, "");
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
		throw new NetworkError(
			`Cannot reach ${credentials.origin}: ${error.cause?.message ?? error.message}. Check the network and any sandbox network allowlist. The key may be fine.`,
		);
	});

	const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
	const bytes = Buffer.from(await response.arrayBuffer());
	return {
		status: response.status,
		ok: response.ok,
		isJson,
		bytes,
		json: isJson ? JSON.parse(bytes.toString("utf8")) : null,
		// files/read-bytes describes the saved file in these headers. Later ranges need the revision.
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
		if (!ACTIVE_JOB_STATUSES.includes(job.status) || Date.now() > deadline) return job;
		await sleep(WAIT_POLL_MS);
	}
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

	// JSON goes out readable. Raw bytes (files/read-bytes) go out unchanged, with their file headers on stderr.
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
	const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
	check_workspace_paths(positionals);
	const items = await stat_paths(load_credentials(), positionals);
	print_json({ items });
	return items.every((item) => item.status === "found") ? 0 : 1;
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

async function command_job(args) {
	const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { wait: { type: "boolean" } } });
	if (positionals.length !== 1) throw new UsageError(`Give one job id.\n\n${USAGE}`);

	const credentials = load_credentials();
	const job = values.wait
		? await wait_for_job(credentials, positionals[0])
		: await post_json(credentials, "files/jobs/get", { jobId: positionals[0] });
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
					const body = await fs.promises.readFile(item.local);
					const put = () =>
						fetch(target.uploadUrl, { method: "PUT", headers: target.headers, body }).catch((error) => ({
							ok: false,
							status: 0,
							// The bytes go to a storage host, not the API origin. A sandbox allowlist needs this host too.
							statusText: `cannot reach ${new URL(target.uploadUrl).host}: ${error.cause?.message ?? error.message}`,
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
	job: command_job,
	upload: command_upload,
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

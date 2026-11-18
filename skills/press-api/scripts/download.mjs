import { setTimeout as sleep } from "node:timers/promises";
import { open_download } from "./download-files.mjs";

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;
const MS_PER_FILE = 500; // The bulk bucket refills at 120 files per minute.

function failure(stage, code, message, status) {
	return Object.assign(new Error(message), { stage, code, status });
}

function network_detail(error) {
	const code = error?.cause?.cause?.code ?? error?.cause?.code ?? error?.cause?.name;
	return typeof code === "string" && /^(?:E[A-Z_]{2,24}|UND_ERR_[A-Z_]{1,32}|TimeoutError|AbortError)$/u.test(code)
		? " (" + code + ")"
		: "";
}

// Response bodies and fetch exceptions can quote a signed URL. Only keep known error codes.
function api_failure(route, result) {
	const codes = [
		"invalid_cursor",
		"rate_limited",
		"not_found",
		"permission_denied",
		"unauthenticated",
		"invalid_input",
	];
	const code = codes.includes(result.json?.errorCode) ? result.json.errorCode : "api_error";
	return failure(route, code, "HTTP " + result.status + " (" + code + ")", result.status);
}

function local_failure(error) {
	const code = typeof error.code === "string" && /^[A-Za-z_]{1,40}$/u.test(error.code) ? error.code : "local_error";
	const known = ["busy", "conflict", "source_changed", "unsafe_path", "invalid_checkpoint", "storage_interrupted"];
	return failure(
		code === "storage_interrupted" ? "storage GET" : "local file",
		code,
		known.includes(code) ? error.message : "Local file operation failed (" + code + ").",
	);
}

async function transfer(origin, target, item, store) {
	let url;
	try {
		url = new URL(target.url);
	} catch {
		throw failure("sign", "invalid_response", "Invalid download link.");
	}
	const localTest = new URL(origin).protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
	if (url.username || url.password || (url.protocol !== "https:" && !(localTest && url.protocol === "http:"))) {
		throw failure("sign", "invalid_response", "Unsafe download link.");
	}
	if (target.expiresAt <= Date.now()) throw failure("storage GET", "expired", "The download link expired.");

	// Stop a stalled connection while allowing a large file to take as long as it needs.
	const controller = new AbortController();
	const idle = setTimeout(() => controller.abort(), 90_000).unref();
	let response;
	try {
		response = await fetch(url, {
			redirect: "error",
			credentials: "omit",
			headers: { "Accept-Encoding": "identity" },
			signal: controller.signal,
		}).catch((error) => {
			throw failure("storage GET", "storage_interrupted", "Could not connect to storage" + network_detail(error) + ".");
		});
		if (response.status !== 200 || !response.body) {
			throw failure("storage GET", "storage_error", "Storage returned HTTP " + response.status + ".", response.status);
		}
		const length = response.headers.get("content-length");
		const body = response.body.pipeThrough(
			new TransformStream({
				transform(chunk, stream) {
					idle.refresh();
					stream.enqueue(chunk);
				},
			}),
		);
		return await store.save(
			item,
			body,
			length !== null && !response.headers.get("content-encoding") ? Number(length) : undefined,
		);
	} finally {
		clearTimeout(idle);
		controller.abort();
		await response?.body?.cancel().catch(() => {});
	}
}

export async function download_folder({ origin, source, destination, resume, post }) {
	let store;
	const report = {
		status: "running",
		source,
		destination,
		filesSeen: 0,
		saved: 0,
		verified: 0,
		bytes: 0,
		retries: 0,
		failed: 0,
		denied: 0,
		conflicts: 0,
	};
	let tokens = BATCH_SIZE;
	let lastCharge = Date.now();
	let lastProgress = 0;
	const beforeCheckpoint = [];

	async function record(error, path, attempt, retry) {
		const entry = {
			time: new Date().toISOString(),
			path,
			stage: error.stage,
			attempt,
			code: error.code,
			...(error.status ? { status: error.status } : {}),
			message: error.message,
			retry,
		};
		process.stderr.write(JSON.stringify(entry) + "\n");
		error.recorded = true;
		if (store) await store.error(entry);
		else beforeCheckpoint.push(entry);
	}

	// The server also charges each refused ID. Share one clock across batches, splits and retries.
	async function pace(count) {
		const now = Date.now();
		tokens = Math.min(BATCH_SIZE, tokens + Math.max(0, now - lastCharge) / MS_PER_FILE);
		const wait = Math.ceil(Math.max(0, count - tokens) * MS_PER_FILE);
		if (wait) {
			process.stderr.write("Waiting " + Math.ceil(wait / 1000) + "s for the download limit.\n");
			await sleep(wait + 25);
		}
		lastCharge = Date.now();
		tokens = Math.max(0, Math.min(BATCH_SIZE, tokens + (lastCharge - now) / MS_PER_FILE) - count);
	}

	async function request(route, body, paths = [source]) {
		for (let attempt = 1; ; attempt++) {
			if (route === "files/download-urls") await pace(body.fileNodeIds.length);
			let detail = "";
			const result = await post(route, body).catch((error) => {
				detail = network_detail(error);
				return null;
			});
			if (route === "files/download-urls") {
				// Count from the reply. Two requests can take different times to reach the server.
				lastCharge = Date.now();
				// A rate refusal spent no file slots. The server gives the wait for this batch.
				if (result?.status === 429) tokens = Math.min(BATCH_SIZE, tokens + body.fileNodeIds.length);
			}
			if (result?.ok) return result.json;
			const error = result
				? api_failure(route, result)
				: failure(route, "network_error", "Could not reach the API or read its answer" + detail + ".");
			const retry = attempt < MAX_ATTEMPTS && (!result || result.status >= 500 || error.code === "rate_limited");
			const restart = error.code === "invalid_cursor" && route === "files/list" && restarts < 3;
			const split = route === "files/download-urls" && result?.status === 403 && paths.length > 1;
			for (const path of paths) await record(error, path, attempt, retry || restart || split);
			if (!retry) throw error;
			report.retries++;
			const wait = result?.json?.retryAfterMs;
			await sleep(Number.isFinite(wait) && wait >= 0 ? Math.ceil(wait) : 250 * 2 ** (attempt - 1));
		}
	}

	async function root_id(workspaceId) {
		if (source === "/") return workspaceId;
		const stat = (await request("files/stat", { paths: [source] })).items[0];
		if (stat?.status === "denied" || stat?.item?.locked)
			throw failure("files/stat", "permission_denied", "Source folder is locked.", 403);
		if (stat?.status !== "found" || stat.item?.kind !== "folder" || !stat.item.nodeId) {
			throw failure("files/stat", "missing_folder", "Source folder was removed or is not a folder.");
		}
		return stat.item.nodeId;
	}

	async function identify() {
		const key = await request("auth/verify");
		if (!key?.scopes?.includes("files:list") || !key.scopes.includes("files:download")) {
			throw failure("auth/verify", "missing_scope", "Folder download needs files:list and files:download.", 403);
		}
		if (
			![key.organizationId, key.workspaceId, key.sponsorUserId].every((id) => typeof id === "string" && id) ||
			!(key.serviceAccountId === null || typeof key.serviceAccountId === "string")
		) {
			throw failure("auth/verify", "invalid_response", "The API did not return the key identity.");
		}
		const rootId = await root_id(key.workspaceId);
		report.workspace = key.organizationName + "/" + key.workspaceName;
		return {
			origin,
			source,
			destination,
			organizationId: key.organizationId,
			workspaceId: key.workspaceId,
			sponsorUserId: key.sponsorUserId,
			serviceAccountId: key.serviceAccountId,
			rootId,
		};
	}

	function count_error(error) {
		if ((error.stage === "files/download-urls" && error.status === 403) || error.code === "permission_denied")
			report.denied++;
		else if (["source_changed", "conflict", "unsafe_path", "EEXIST"].includes(error.code)) report.conflicts++;
		else report.failed++;
	}

	const list = (cursor) => request("files/list", { path: source, recursive: true, limit: 100, cursor });
	let identity;
	async function recheck_root(checkList = false) {
		if (JSON.stringify(identity) !== JSON.stringify(await identify())) {
			throw failure("source", "source_changed", "Source folder or workspace identity changed.");
		}
		if (checkList && source === "/") await list(null);
	}

	async function sign_and_save(batch) {
		let signed;
		try {
			signed = await request(
				"files/download-urls",
				{ fileNodeIds: batch.map(({ item }) => item.nodeId) },
				batch.map(({ item }) => item.path),
			);
		} catch (error) {
			if (error.status === 401 || error.code === "network_error" || error.code === "rate_limited") throw error;
			if (error.status === 403) {
				await recheck_root(true);
				if (batch.length > 1) {
					const half = Math.ceil(batch.length / 2);
					await sign_and_save(batch.slice(0, half));
					await sign_and_save(batch.slice(half));
					return;
				}
			}
			for (let index = 0; index < batch.length; index++) count_error(error);
			return;
		}
		// Refuse a broken batch before publishing bytes for an unexpected or ambiguous ID.
		const entries = new Map();
		for (const entry of [...(signed?.items ?? []), ...(signed?.errors ?? [])]) {
			if (entries.has(entry.fileNodeId)) throw failure("sign", "invalid_response", "Duplicate ID in download answer.");
			entries.set(entry.fileNodeId, entry);
		}
		if (
			signed?.truncated !== false ||
			entries.size !== batch.length ||
			batch.some(({ item }) => !entries.has(item.nodeId))
		) {
			for (const { item } of batch) {
				await record(failure("sign", "invalid_response", "Incomplete download batch."), item.path, 1, false);
				report.failed++;
			}
			return;
		}

		const queue = [...batch];
		const expired = [];
		const workers = await Promise.allSettled(
			Array.from({ length: Math.min(4, queue.length) }, async () => {
				for (let job = queue.shift(); job; job = queue.shift()) {
					const { item } = job;
					const target = entries.get(item.nodeId);
					if (!target.url || !Number.isFinite(target.expiresAt)) {
						const denied = target.errorCode === "permission_denied";
						const error = failure(
							"sign",
							denied ? "permission_denied" : target.errorCode === "not_found" ? "not_found" : "invalid_response",
							denied
								? "Permission denied."
								: target.errorCode === "not_found"
									? "File not found."
									: "Missing download link or expiry.",
						);
						await record(error, item.path, job.attempt, false);
						count_error(error);
						continue;
					}
					for (;;) {
						try {
							const bytes = await transfer(origin, target, item, store);
							report.bytes += bytes;
							report.saved++;
							if (Date.now() - lastProgress >= 1000) await progress();
							break;
						} catch (cause) {
							const error = cause.stage ? cause : local_failure(cause);
							const renew = error.code === "expired" || error.status === 401 || error.status === 403;
							const retry =
								job.attempt < MAX_ATTEMPTS &&
								(renew || error.code === "storage_interrupted" || error.status === 429 || error.status >= 500);
							await record(error, item.path, job.attempt, retry);
							if (["invalid_checkpoint", "ENOSPC"].includes(error.code)) throw error;
							if (!retry) {
								count_error(error);
								break;
							}
							report.retries++;
							await sleep(250 * 2 ** (job.attempt++ - 1));
							if (renew) {
								expired.push(job);
								break;
							}
						}
					}
				}
			}),
		);
		for (const result of workers) if (result.status === "rejected") throw result.reason;
		if (expired.length) await sign_and_save(expired);
	}

	async function progress() {
		lastProgress = Date.now();
		await store.progress(report);
		process.stderr.write(
			report.filesSeen +
				" files seen, " +
				report.saved +
				" saved, " +
				report.verified +
				" verified, " +
				report.bytes +
				" bytes saved, " +
				report.retries +
				" retries.\n",
		);
	}

	let restarts = 0;
	try {
		identity = await identify();
		let cursor = null;
		for (;;) {
			let page;
			try {
				page = await list(cursor);
			} catch (error) {
				if (error.code !== "invalid_cursor" || ++restarts > 3) throw error;
				await recheck_root();
				cursor = null;
				if (store) await store.begin_scan();
				report.retries++;
				Object.assign(report, { filesSeen: 0, saved: 0, verified: 0, bytes: 0, failed: 0, denied: 0, conflicts: 0 });
				continue;
			}
			// A first page has no cursor bound to the original folder. Check its identity again
			// before writing any rows in case another folder took the path during the request.
			if (cursor === null && (await root_id(identity.workspaceId)) !== identity.rootId) {
				throw failure("source", "source_changed", "The source folder changed while it was listed.");
			}
			if (!store) {
				process.stderr.write(
					JSON.stringify(report.workspace) +
						"  " +
						JSON.stringify(source) +
						" -> " +
						JSON.stringify(destination) +
						"\n",
				);
				store = await open_download(destination, identity, resume);
				report.errors = store.errors;
				for (const entry of beforeCheckpoint) await store.error(entry);
				await store.begin_scan();
				await progress();
			}
			if (!Array.isArray(page?.items) || typeof page.isDone !== "boolean" || (!page.isDone && !page.cursor)) {
				throw failure("files/list", "invalid_response", "Incomplete folder listing.");
			}
			const batch = [];
			for (const item of page.items) {
				let action;
				try {
					action = await store.inspect(item);
				} catch (cause) {
					const error = local_failure(cause);
					if (["invalid_checkpoint", "ENOSPC"].includes(error.code)) throw error;
					await record(error, item.path, 1, false);
					count_error(error);
					if (item.kind === "file") report.filesSeen++;
					continue;
				}
				if (action === "duplicate") continue;
				if (item.kind === "file") report.filesSeen++;
				if (action === "download") batch.push({ item, attempt: 1 });
				else if (action === "verified") report.verified++;
				else if (action === "denied" || action === "pending") {
					const error =
						action === "denied"
							? failure("list", "permission_denied", "Permission denied.")
							: failure("list", "pending", "Upload is still pending.");
					await record(error, item.path, 1, false);
					count_error(error);
				}
				if (batch.length === BATCH_SIZE) {
					await sign_and_save(batch.splice(0));
					await progress();
				}
			}
			if (batch.length) await sign_and_save(batch);
			await progress();
			if (page.isDone) break;
			cursor = page.cursor;
		}
		for await (const item of store.unseen()) {
			await record(
				failure("list", "no_longer_listed", "Previously seen path is no longer listed."),
				item.path,
				1,
				false,
			);
			report.conflicts++;
		}
		report.status = report.failed || report.denied || report.conflicts ? "partial" : "complete";
		await store.progress(report);
		return { report, exitCode: report.status === "complete" ? 0 : 1 };
	} catch (cause) {
		const error = cause.stage ? cause : local_failure(cause);
		report.status = "partial";
		report.message = error.message;
		report.runError = { stage: error.stage, code: error.code, status: error.status, message: error.message };
		try {
			if (!error.recorded) await record(error, source, 1, false);
			if (store) await store.progress(report);
		} catch {
			report.checkpointUpdated = false;
			process.stderr.write("Could not update the local checkpoint. Check the destination and available space.\n");
		}
		return { report, exitCode: error.code === "network_error" ? 3 : 1 };
	} finally {
		await store?.close();
	}
}

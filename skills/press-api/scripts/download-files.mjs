import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

function problem(code, message) {
	return Object.assign(new Error(message), { code });
}

function hash(value) {
	return createHash("sha256").update(value).digest("hex");
}

function stat(file) {
	return fs.lstatSync(file, { throwIfNoEntry: false });
}

// Walk from the root each time. A directory checked during listing may be a junction by download time.
function directory(dir, create = false) {
	const root = path.parse(dir).root;
	let current = root;
	for (const name of dir.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, name);
		let entry = stat(current);
		if (!entry && create) {
			fs.mkdirSync(current, { mode: 0o700 });
			entry = stat(current);
		}
		if (!entry?.isDirectory() || entry.isSymbolicLink()) {
			throw problem("unsafe_path", "Local folder is missing, is a link, or is a file: " + current);
		}
	}
}

function read_json(file) {
	const entry = stat(file);
	if (!entry) return null;
	if (!entry.isFile() || entry.nlink !== 1) throw problem("invalid_checkpoint", "Unsafe checkpoint file: " + file);
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw problem("invalid_checkpoint", "Unreadable checkpoint file: " + file);
	}
}

function write_json(file, value) {
	const temp = file + "." + randomUUID() + ".tmp";
	try {
		fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

// Windows pipes and Linux abstract sockets disappear when the owning process dies. On other Unix
// systems a hard kill may leave a socket file. Skip its name only after a refused connection.
function socket_name(checkpoint, generation) {
	const id = hash(fs.realpathSync.native(checkpoint));
	if (process.platform === "win32") return "\\\\.\\pipe\\bonobo-download-" + id;
	if (process.platform === "linux") return "\0bonobo-download-" + id;
	// A Unix socket address is short even when the destination is many folders deep.
	const user = process.getuid();
	const sockets = path.join("/tmp", "bonobo-download-" + user);
	fs.mkdirSync(sockets, { mode: 0o700, recursive: true });
	const entry = stat(sockets);
	if (!entry.isDirectory() || entry.uid !== user || (entry.mode & 0o077) !== 0) {
		throw problem("unsafe_path", "The local writer lock needs a private socket directory.");
	}
	return path.join(sockets, id.slice(0, 40) + "-" + generation + ".sock");
}

async function connected(socket) {
	return await new Promise((resolve, reject) => {
		const client = net.createConnection(socket);
		client.once("connect", () => {
			client.destroy();
			resolve(true);
		});
		client.once("error", (error) => {
			if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
			else reject(error);
		});
	});
}

async function lock(checkpoint) {
	for (let generation = 0; ; generation++) {
		const socket = socket_name(checkpoint, generation);
		const server = net.createServer((client) => client.end());
		try {
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(socket, resolve);
			});
			return () => new Promise((resolve) => server.close(resolve));
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
			if (["win32", "linux"].includes(process.platform) || (await connected(socket))) {
				throw problem("busy", "Another download is writing this destination.");
			}
		}
	}
}

export async function download_status(destination) {
	const checkpoint = path.resolve(destination) + ".bonobo-download";
	directory(checkpoint);
	let summary = read_json(path.join(checkpoint, "progress.json"));
	if (!summary) {
		const run = read_json(path.join(checkpoint, "run.json"));
		if (!run?.identity) throw problem("invalid_checkpoint", "No download progress is saved here.");
		summary = {
			source: run.identity.source,
			destination: run.destination,
			status: "running",
			saved: 0,
			verified: 0,
			updatedAt: fs.statSync(path.join(checkpoint, "run.json")).mtime.toISOString(),
		};
	}
	if (summary.status === "running") {
		for (let generation = 0; ; generation++) {
			const socket = socket_name(checkpoint, generation);
			if (await connected(socket)) break;
			if (["win32", "linux"].includes(process.platform) || !stat(socket)) {
				return { ...summary, status: "interrupted" };
			}
		}
	}
	return summary;
}

function local_path(destination, source, remote) {
	const prefix = source === "/" ? "/" : source + "/";
	if (!remote.startsWith(prefix)) throw problem("unsafe_path", "File is outside the requested folder.");
	const names = remote.slice(prefix.length).split("/");
	for (const name of names) {
		if (!name || name === "." || name === ".." || /[\\:\x00-\x1f]/u.test(name)) {
			throw problem("unsafe_path", "File has an unsafe local name.");
		}
		if (
			process.platform === "win32" &&
			(/[<>"|?*]|[. ]$/u.test(name) || /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/iu.test(name))
		) {
			throw problem("unsafe_path", "File name cannot be used on Windows.");
		}
	}
	return path.join(destination, ...names);
}

function check_spelling(dir, destination) {
	const actual = fs.realpathSync.native(dir);
	const base = fs.realpathSync.native(destination);
	if (path.relative(base, actual) !== path.relative(destination, dir)) {
		throw problem("conflict", "Two folder names refer to the same local folder.");
	}
}

async function file_matches(file, receipt) {
	const entry = stat(file);
	if (!entry?.isFile() || entry.size !== receipt.size) return false;
	const digest = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
	return digest.digest("hex") === receipt.digest;
}

// After a kill, a staged file with one link has no published copy. It can be dropped even when
// the remote file has become locked or disappeared. Two links may be needed to finish a receipt.
function discard_unpublished(receipt) {
	const temp = receipt + ".part";
	if (stat(temp)?.nlink === 1) fs.unlinkSync(temp);
}

async function* storage_bytes(body) {
	try {
		yield* body;
	} catch {
		throw problem("storage_interrupted", "The storage response ended before all bytes arrived.");
	}
}

export async function open_download(destination, identity, resume) {
	destination = path.resolve(destination);
	if (path.parse(destination).root === destination)
		throw problem("unsafe_path", "Choose a destination below the filesystem root.");
	const checkpoint = destination + ".bonobo-download";
	directory(path.dirname(checkpoint), !resume);
	if (stat(destination)) {
		directory(destination);
		destination = fs.realpathSync.native(destination);
	} else if (resume && stat(checkpoint)) {
		directory(checkpoint);
		destination = fs.realpathSync.native(checkpoint).slice(0, -".bonobo-download".length);
	} else {
		destination = path.join(fs.realpathSync.native(path.dirname(destination)), path.basename(destination));
	}
	const expected = {
		version: 1,
		hostname: os.hostname(),
		platform: process.platform,
		destination,
		identity: { ...identity, destination },
	};
	if (!resume) {
		// Publish the identity and checkpoint together. A kill before this rename leaves the requested
		// destination free for a fresh start. A kill after it leaves a run that can already resume.
		if (stat(checkpoint)) throw problem("conflict", "Checkpoint already exists. Use --resume or another destination.");
		const bootstrap = fs.mkdtempSync(checkpoint + ".starting-");
		try {
			write_json(path.join(bootstrap, "run.json"), expected);
			fs.renameSync(bootstrap, checkpoint);
		} catch (error) {
			fs.rmSync(path.join(bootstrap, "run.json"), { force: true });
			fs.rmdirSync(bootstrap);
			if (stat(checkpoint))
				throw problem("conflict", "Checkpoint already exists. Use --resume or another destination.");
			throw error;
		}
	}
	directory(checkpoint);
	const close = await lock(checkpoint);
	try {
		if (!isDeepStrictEqual(read_json(path.join(checkpoint, "run.json")), expected)) {
			throw problem(
				"invalid_checkpoint",
				"The machine, source, workspace, key identity, or destination differs from the saved run.",
			);
		}
		directory(destination, true);
		const receipts = path.join(checkpoint, "receipts");
		directory(receipts, true);
		const checkpointDevice = fs.statSync(receipts, { bigint: true }).dev;
		const errors = path.join(checkpoint, "errors.jsonl");
		if (!stat(errors)) fs.writeFileSync(errors, "", { flag: "wx", mode: 0o600 });
		let scan = randomUUID();

		function receipt_path(remote, byId = false) {
			const key = hash(remote);
			const shard = path.join(receipts, key.slice(0, 2));
			directory(shard, true);
			return path.join(shard, key + (byId ? ".node" : ".json"));
		}

		return {
			errors,
			close,
			begin_scan() {
				scan = randomUUID();
			},
			progress(summary) {
				directory(checkpoint);
				write_json(path.join(checkpoint, "progress.json"), { ...summary, updatedAt: new Date().toISOString() });
			},
			error(record) {
				directory(checkpoint);
				const entry = stat(errors);
				if (entry && (!entry.isFile() || entry.nlink !== 1)) throw problem("invalid_checkpoint", "Unsafe error log.");
				fs.appendFileSync(errors, JSON.stringify(record) + "\n", { mode: 0o600 });
			},
			async inspect(item) {
				const target = local_path(destination, identity.source, item.path);
				const receipt = receipt_path(item.path);
				const previous = read_json(receipt);
				if (previous) discard_unpublished(receipt);
				const facts = previous ?? { path: item.path, nodeId: item.nodeId, kind: item.kind, updatedAt: item.updatedAt };
				if (facts.path !== item.path) throw problem("invalid_checkpoint", "Invalid path in download receipt.");
				const duplicate = facts.scan === scan;
				facts.scan = scan;
				if (!duplicate) write_json(receipt, facts);
				if (item.kind !== facts.kind || item.nodeId !== facts.nodeId) {
					if (item.locked) return "denied";
					throw problem("source_changed", "A different item now owns this path.");
				}
				if (duplicate) return "duplicate";
				if (item.locked) return "denied";
				const node = receipt_path(item.nodeId, true);
				const original = read_json(node);
				if (original && original.path !== item.path) {
					const oldFile = receipt_path(original.path);
					const old = read_json(oldFile);
					if (old) write_json(oldFile, { ...old, scan });
					throw problem("source_changed", "The item moved from " + original.path);
				}
				if (!original) write_json(node, { path: item.path });
				if (item.status === "pending") return "pending";
				const parent = path.dirname(target);
				directory(parent, true);
				check_spelling(parent, destination);
				if (item.kind === "folder") {
					directory(target, true);
					check_spelling(target, destination);
					return "directory";
				}

				const temp = receipt + ".part";
				const output = stat(target);
				if (output) {
					if (!facts.digest || !output.isFile()) throw problem("conflict", "A local item already exists.");
					if (facts.installing) {
						const staged = fs.lstatSync(temp, { throwIfNoEntry: false, bigint: true });
						const final = fs.lstatSync(target, { bigint: true });
						if (!staged?.isFile() || staged.ino !== final.ino || staged.dev !== final.dev) {
							throw problem("conflict", "Another file was created before the download finished.");
						}
					}
					if (!(await file_matches(target, facts))) throw problem("conflict", "The local copy changed.");
					directory(path.dirname(receipt));
					if (facts.installing) {
						delete facts.installing;
						write_json(receipt, facts);
					}
					fs.rmSync(temp, { force: true });
					if (item.updatedAt !== facts.updatedAt)
						throw problem("source_changed", "The remote item changed after download.");
					return "verified";
				}
				if (facts.digest && facts.updatedAt !== item.updatedAt) {
					throw problem("source_changed", "The remote item changed after download.");
				}
				if (fs.statSync(parent, { bigint: true }).dev !== checkpointDevice) {
					throw problem("unsafe_path", "The target folder and download checkpoint must be on the same filesystem.");
				}
				return "download";
			},
			async save(item, body, expectedBytes) {
				const target = local_path(destination, identity.source, item.path);
				const receipt = receipt_path(item.path);
				const temp = receipt + ".part";
				const digest = createHash("sha256");
				let size = 0;
				// Only this run writes in the private shard. A hard kill may leave an incomplete file here.
				fs.rmSync(temp, { force: true });
				const fd = fs.openSync(temp, "wx", 0o600);
				let complete = false;
				try {
					for await (const chunk of storage_bytes(body)) {
						digest.update(chunk);
						let offset = 0;
						while (offset < chunk.length) offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
						size += chunk.length;
					}
					if (expectedBytes != null && size !== expectedBytes) {
						throw problem("storage_interrupted", "The download length differs from the storage response.");
					}
					fs.fsyncSync(fd);
					complete = true;
				} finally {
					fs.closeSync(fd);
					if (!complete) {
						directory(path.dirname(temp));
						fs.rmSync(temp, { force: true });
					}
				}
				const facts = {
					path: item.path,
					nodeId: item.nodeId,
					kind: item.kind,
					updatedAt: item.updatedAt,
					scan,
					size,
					digest: digest.digest("hex"),
				};
				directory(path.dirname(receipt));
				write_json(receipt, { ...facts, installing: true });
				directory(path.dirname(target));
				check_spelling(path.dirname(target), destination);
				try {
					fs.linkSync(temp, target);
				} catch (error) {
					fs.unlinkSync(temp);
					if (error.code === "EEXIST") throw problem("conflict", "A local item already exists.");
					throw error;
				}
				write_json(receipt, facts);
				fs.unlinkSync(temp);
				return size;
			},
			async *unseen() {
				directory(receipts);
				for await (const shard of await fs.promises.opendir(receipts)) {
					const dir = path.join(receipts, shard.name);
					directory(dir);
					for await (const file of await fs.promises.opendir(dir)) {
						if (!file.name.endsWith(".json")) continue;
						const receipt = path.join(dir, file.name);
						const record = read_json(receipt);
						if (record.scan !== scan) {
							discard_unpublished(receipt);
							yield { path: record.path, nodeId: record.nodeId, kind: record.kind };
						}
					}
				}
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

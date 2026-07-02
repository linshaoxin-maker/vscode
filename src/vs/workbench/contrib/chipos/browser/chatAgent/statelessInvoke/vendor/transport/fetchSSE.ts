/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/transport/fetchSSE.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/*---------------------------------------------------------------------------------------------
 *  Phase 2-A: shared SSE transport primitive.
 *
 *  `fetchEventStream` is the one place that knows how to: open an HTTP request,
 *  read its body as a stream, parse the SSE `data:` frames, and hand each parsed
 *  event to a callback — with a re-armable idle timeout and an optional
 *  reconnect policy. Both ReasonerClient (POST /invoke, reconnect OFF — drops
 *  are recovered via /resume) and the future WorkerClient (GET permission
 *  stream, reconnect ON) build on it. This is the first block of the shared
 *  client SDK the surface-unification plan calls for.
 *
 *  Why fetch + ReadableStream instead of EventSource: EventSource can't send an
 *  Authorization header, can't POST a body, and can't read a POST's SSE
 *  response — all three of which the reasoner protocol requires.
 *
 *  No vscode import — this is pure transport, unit-testable with an injected
 *  fetch.
 *--------------------------------------------------------------------------------------------*/

/** Backoff policy for transient-drop reconnects. Off by default. */
export interface ReconnectPolicy {
	/** Max reconnect attempts after the first connection. */
	maxAttempts: number;
	/** Base delay in ms (attempt n waits min(base * 2^(n-1), max)). Default 1000. */
	baseMs?: number;
	/** Max delay cap in ms. Default 30000. */
	maxMs?: number;
}

export interface FetchEventStreamInit {
	/** HTTP method. Default 'POST'. */
	method?: string;
	headers?: Record<string, string>;
	/** Pre-serialized request body (e.g. JSON.stringify(...)). Omit for none. */
	body?: string;
	/** Caller abort signal — aborting tears down the stream and is never retried. */
	signal?: AbortSignal;
	/** Inject for tests; defaults to global fetch. */
	fetchFn?: typeof fetch;
	/**
	 * Re-armable idle timeout (ms). The abort fires only after a TRUE gap of this
	 * long with no bytes received — keepalives (~25s) keep a healthy stream, or a
	 * long human-confirm wait, alive indefinitely. Default 600_000 (10 min).
	 */
	idleTimeoutMs?: number;
	/** Optional reconnect-on-transient-drop policy. Default: no reconnect. */
	reconnect?: ReconnectPolicy;
	/** Called once each time the response stream opens (initial + each reconnect). */
	onOpen?: () => void;
	/** Called before a reconnect sleep, for logging. */
	onReconnect?: (attempt: number, delayMs: number, err: unknown) => void;
}

/** Translate a specific HTTP status into a typed error before the generic SseHttpError. */
export interface SseStatusOverride {
	onStatus: number;
	toError: () => Error;
}

/** Thrown when the server responds non-2xx (after status overrides are applied). */
export class SseHttpError extends Error {
	readonly status: number;
	readonly body: unknown;

	constructor(status: number, body: unknown, message?: string) {
		super(message ?? `SSE request failed with HTTP ${status}`);
		this.name = 'SseHttpError';
		this.status = status;
		this.body = body;
	}
}

/**
 * Parse a single SSE "event block" (the text between two `\n\n` separators) into
 * its decoded JSON payload, or `undefined` if the block has no `data:` field
 * (comment / keep-alive blocks). Multi-line `data:` fields are concatenated with
 * `\n` per the SSE spec before JSON.parse. Lenient about `\r\n` line endings.
 *
 * Malformed JSON returns `undefined` (skip the frame, keep the stream alive)
 * rather than throwing — one bad event mid-stream shouldn't kill the round.
 *
 * Exported for unit testing and reuse.
 */
export function parseSseEventBlock(block: string): unknown | undefined {
	const dataLines: string[] = [];
	for (const rawLine of block.split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			continue;
		}
		if (line.startsWith(':')) {
			// SSE comment / keep-alive — skip.
			continue;
		}
		const colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		const name = line.slice(0, colon);
		if (name !== 'data') {
			// event:/id:/retry: — reasoner routes via the JSON payload, not these.
			continue;
		}
		let value = line.slice(colon + 1);
		if (value.startsWith(' ')) {
			value = value.slice(1);
		}
		dataLines.push(value);
	}
	if (dataLines.length === 0) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(dataLines.join('\n'));
		// Fuzz hardening: a syntactically-valid SCALAR frame is not a protocol
		// event — `data: null` parses fine then crashes the consumer's handler
		// (killing the whole round, defeating the skip-bad-frame contract above),
		// and a bare `1e999` leaks Infinity. Protocol events are JSON objects;
		// treat anything else like malformed JSON and skip.
		return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Open an SSE request and invoke `onEvent` for every parsed `data:` frame.
 * Resolves when the server closes the stream cleanly; rejects on caller-abort
 * (AbortError), non-2xx status (SseHttpError, or a status-override error), or an
 * unrecoverable network error.
 *
 * When `init.reconnect` is set, a transient network drop (not an abort, not an
 * HTTP status error) triggers a backoff + retry of the same request. Reasoner
 * invoke deliberately leaves reconnect off: re-POSTing /invoke would start a new
 * turn, so drops are recovered out-of-band via /resume instead.
 */
export async function fetchEventStream(
	url: string,
	init: FetchEventStreamInit,
	onEvent: (data: unknown) => void,
	statusOverrides?: SseStatusOverride[],
): Promise<void> {
	const fetchFn = init.fetchFn ?? ((input, reqInit) => fetch(input, reqInit));
	const idleTimeoutMs = init.idleTimeoutMs ?? 600_000;
	const maxAttempts = init.reconnect ? Math.max(0, init.reconnect.maxAttempts) : 0;
	const baseMs = init.reconnect?.baseMs ?? 1000;
	const maxMs = init.reconnect?.maxMs ?? 30_000;

	let attempt = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await runOnce(url, init, onEvent, statusOverrides, fetchFn, idleTimeoutMs);
			return;
		} catch (err) {
			// Caller cancelled — never retry.
			if (init.signal?.aborted || isAbortError(err)) {
				throw err;
			}
			// HTTP status errors aren't transient — re-issuing won't help.
			if (err instanceof SseHttpError || isStatusOverrideError(err, statusOverrides)) {
				throw err;
			}
			if (attempt >= maxAttempts) {
				throw err;
			}
			attempt++;
			const delay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
			init.onReconnect?.(attempt, delay, err);
			await abortableDelay(delay, init.signal);
		}
	}
}

/** A single connection attempt: fetch → status checks → read → parse → onEvent. */
async function runOnce(
	url: string,
	init: FetchEventStreamInit,
	onEvent: (data: unknown) => void,
	statusOverrides: SseStatusOverride[] | undefined,
	fetchFn: typeof fetch,
	idleTimeoutMs: number,
): Promise<void> {
	const headers: Record<string, string> = { Accept: 'text/event-stream', ...(init.headers ?? {}) };
	const { controller, reset, clear } = makeIdleTimeoutController(init.signal, idleTimeoutMs);

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const resp = await fetchFn(url, {
			method: init.method ?? 'POST',
			headers,
			body: init.body,
			signal: controller.signal,
		});

		if (statusOverrides) {
			for (const ov of statusOverrides) {
				if (resp.status === ov.onStatus) {
					await drainBody(resp);
					throw ov.toError();
				}
			}
		}
		if (!resp.ok) {
			throw new SseHttpError(resp.status, await parseBodySafe(resp));
		}
		if (!resp.body) {
			// 2xx with no body → empty stream, terminate immediately.
			return;
		}

		init.onOpen?.();
		reader = resp.body.getReader();
		const decoder = new TextDecoder('utf-8');
		let buffer = '';

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const { done, value } = await reader.read();
			// Any chunk (incl. keepalive) re-arms the idle timeout.
			reset();
			if (done) {
				// A final event without a trailing blank line (some servers omit it
				// before close): try to parse the remaining buffer as one block.
				if (buffer.length > 0) {
					emit(parseSseEventBlock(buffer), onEvent);
				}
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			buffer = flushFrames(buffer, onEvent);
		}
	} finally {
		clear();
		if (reader) {
			try {
				await reader.cancel();
			} catch {
				/* best-effort */
			}
		}
	}
}

/**
 * Split complete SSE frames out of `buffer`, emit each, and return the trailing
 * (incomplete) fragment to keep for the next read. Frames are separated by a
 * blank line (`\n\n`); `\r\n` is normalised for lenient proxy handling.
 */
function flushFrames(buffer: string, onEvent: (data: unknown) => void): string {
	const normalized = buffer.replace(/\r\n/g, '\n');
	const parts = normalized.split('\n\n');
	const tail = parts.pop() ?? '';
	for (const block of parts) {
		emit(parseSseEventBlock(block), onEvent);
	}
	return tail;
}

function emit(parsed: unknown | undefined, onEvent: (data: unknown) => void): void {
	if (parsed !== undefined) {
		onEvent(parsed);
	}
}

/**
 * One AbortController that fires when EITHER the caller's signal aborts OR no
 * chunk arrives within `idleMs`. `reset()` re-arms the idle timer on each chunk;
 * `clear()` releases everything once the request settles.
 */
function makeIdleTimeoutController(
	callerSignal: AbortSignal | undefined,
	idleMs: number,
): { controller: AbortController; reset: () => void; clear: () => void } {
	const controller = new AbortController();
	const onCallerAbort = () => {
		try {
			controller.abort((callerSignal as AbortSignal & { reason?: unknown })?.reason);
		} catch {
			/* best-effort */
		}
	};
	if (callerSignal) {
		if (callerSignal.aborted) {
			onCallerAbort();
		} else {
			callerSignal.addEventListener('abort', onCallerAbort, { once: true });
		}
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		timer = setTimeout(() => {
			try {
				controller.abort(new Error(`SSE stream idle for ${idleMs}ms`));
			} catch {
				/* best-effort */
			}
		}, idleMs);
	};
	arm();

	return {
		controller,
		reset: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			arm();
		},
		clear: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (callerSignal) {
				callerSignal.removeEventListener('abort', onCallerAbort);
			}
		},
	};
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === 'AbortError';
}

function isStatusOverrideError(err: unknown, overrides: SseStatusOverride[] | undefined): boolean {
	if (!overrides || !(err instanceof Error)) {
		return false;
	}
	// Override errors are user-supplied custom Error subclasses; the only generic
	// signal we can rely on is "not a network error". Treat any thrown value that
	// the override factories could produce as non-retryable by identity check.
	return overrides.some(ov => {
		try {
			return err.constructor === ov.toError().constructor;
		} catch {
			return false;
		}
	});
}

/** Resolve after `ms`, or reject early if `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException('Aborted', 'AbortError'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException('Aborted', 'AbortError'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function drainBody(resp: Response): Promise<void> {
	try {
		await resp.text();
	} catch {
		/* best-effort */
	}
}

async function parseBodySafe(resp: Response): Promise<unknown> {
	try {
		return await resp.json();
	} catch {
		try {
			return await resp.text();
		} catch {
			return undefined;
		}
	}
}

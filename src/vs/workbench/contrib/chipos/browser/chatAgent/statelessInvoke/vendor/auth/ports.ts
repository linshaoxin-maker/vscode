/* ────────────────────────────────────────────────────────────────────
 * VENDORED — DO NOT EDIT BY HAND. Regenerate via: npm run sync (in packages/invoke-client)
 * canonical source: packages/invoke-client/src/auth/ports.ts
 * @chipos/invoke-client — shared reasoner /invoke client (B phase: vendored copy; ADR-CLI-009 / 09-landing).
 * ──────────────────────────────────────────────────────────────────── */
/**
 * Ports for the canonical auth token-lifecycle core (doc-20 · A2).
 *
 * The core (`tokenManager.ts`) is a pure in-memory state machine — expiry parse,
 * auto-refresh timer, concurrent-refresh dedup, JWT-claims decode, refresh-and-
 * store. It reaches the outside world ONLY through these structural ports, so the
 * three surfaces bind their own backends:
 *   - TokenStore:  IDE=ISecretStorageService / ext=vscode.SecretStorage / CLI=file
 *   - Logger:      IDE=ILogService / ext=ILogger shim / CLI=console (all assignable)
 *   - website URL: IDE=product.json+config / ext=config / CLI=env+cfg (a resolver fn)
 *
 * Events are a tiny self-contained emitter (SimpleEmitter) — no vs `Emitter`
 * dependency (mirrors invoke-client's structural-interface convention). A surface
 * whose consumers need a native `Event<T>` (the IDE) bridges: it subscribes to the
 * core's event and re-fires its own Emitter.
 */

/** Async secret key/value store. Keys are the KEY_* constants in tokenManager.ts. */
export interface TokenStore {
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * Structural logger — every method optional so a surface can pass a partial impl.
 * vscode `ILogService` and the extension's `ILogger` shim are both assignable.
 */
export interface Logger {
	trace?(message: string, ...args: unknown[]): void;
	info?(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
	error?(message: string, ...args: unknown[]): void;
}

/** Structural disposable (vs `IDisposable` / `vscode.Disposable` assignable). */
export interface Disposable {
	dispose(): void;
}

export type Listener<T> = (e: T) => void;

/**
 * A minimal event emitter — no external dependency. `event` registers a listener
 * and returns a disposer; `fire` notifies all current listeners (a throwing
 * listener is isolated so one bad subscriber can't break the others or the auth
 * state machine). Structurally, `event` is a `(listener) => Disposable`, which a
 * surface can adapt to a native `Event<T>` by bridging.
 */
export class SimpleEmitter<T> {
	private readonly _listeners = new Set<Listener<T>>();

	readonly event = (listener: Listener<T>): Disposable => {
		this._listeners.add(listener);
		return { dispose: () => { this._listeners.delete(listener); } };
	};

	fire(value: T): void {
		// Snapshot so a listener that (dis)subscribes mid-fire doesn't perturb the loop.
		for (const listener of [...this._listeners]) {
			try {
				listener(value);
			} catch {
				/* isolate — auth events must not throw into the state machine */
			}
		}
	}

	dispose(): void {
		this._listeners.clear();
	}
}

/**
 * chunked_fill.js
 *
 * Time-sliced list/card populator (the "chunked" half of the chunked
 * library loading). Building hundreds of cards -- and starting hundreds
 * of thumbnail fetches -- in one synchronous loop is what froze the node
 * on open and made the first scroll frames jank; this class spreads the
 * same work across animation frames so the browser keeps painting (and
 * keeps answering input) while the grid fills in.
 *
 * How it is meant to be used:
 *   const filler = new ChunkedFiller({
 *       build: (item) => makeCardElement(item),   // one item -> one node
 *       appendNode: (node) => container.append(node),
 *       onBatch: (nodes) => applyFilter(nodes),   // optional, per frame
 *   });
 *   filler.push(entries);        // may be called repeatedly (streamed pages)
 *   filler.whenIdle().then(...)  // resolves once the queue has drained
 *   filler.cancel();             // drop everything pending (stale render)
 *
 * `push` is append-only and idempotent in ORDER but not in CONTENT: the
 * caller owns dedup (see ComposerUI._libRenderedRefs) because a library
 * re-scan can hand the same entries over twice across pages. Nodes are
 * built lazily from `build` at append time, so a queued item that is no
 * longer wanted can simply be dropped with cancel().
 *
 * Scheduling is injectable (`schedule`) purely so the node-side tests
 * can pump frames deterministically; production uses rAF (falling back
 * to setTimeout where rAF is absent, e.g. detached worker contexts).
 */

const nowMs = () => (typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now());

const defaultSchedule = (cb) => {
    if (typeof requestAnimationFrame === "function") return requestAnimationFrame(cb);
    return setTimeout(cb, 16);
};

export class ChunkedFiller {
    /**
     * @param {object} opts
     * @param {(item) => Node|null} opts.build  creates the element for one item
     * @param {(node) => void} opts.appendNode  attaches one element
     * @param {(nodes: Node[]) => void} [opts.onBatch] called after each frame's
     *   appends with exactly the nodes added that frame (incremental filtering)
     * @param {number} [opts.maxNodesPerChunk] hard cap of nodes per frame
     * @param {number} [opts.frameBudgetMs] stop appending once a frame's
     *   work exceeds this; at least one node is always appended so the
     *   filler can never livelock on a slow `build`
     * @param {(cb: Function) => any} [opts.schedule] frame source (tests)
     */
    constructor({ build, appendNode, onBatch, maxNodesPerChunk = 24, frameBudgetMs = 8, schedule } = {}) {
        if (typeof build !== "function" || typeof appendNode !== "function") {
            throw new Error("ChunkedFiller requires build() and appendNode()");
        }
        this._build = build;
        this._appendNode = appendNode;
        this._onBatch = onBatch || null;
        this._max = Math.max(1, maxNodesPerChunk | 0);
        this._budget = frameBudgetMs;
        this._schedule = schedule || defaultSchedule;

        this._queue = [];
        this._running = false;
        this._cancelled = false;
        this._idleWaiters = [];
        this._tickGen = 0;
    }

    /** False once cancel() has run; pushes after that are ignored. */
    get active() {
        return !this._cancelled;
    }

    get pending() {
        return this._queue.length;
    }

    /** Queue items for appending. Safe to call from a stream chunk callback. */
    push(items) {
        if (this._cancelled || !items || !items.length) return;
        for (const item of items) this._queue.push(item);
        this._start();
    }

    /** Append everything still queued, in one synchronous pass. Used by the
     * headless tests and available as an escape hatch ("fill now" actions).
     * Invalidates any already-scheduled frame (the tick generation moves,
     * the stale tick no-ops) so a later push() can't double-run. */
    drainSync() {
        this._tickGen += 1;
        while (this._queue.length && !this._cancelled) this._fillOneFrame(Number.POSITIVE_INFINITY);
        this._running = false;
        this._finishIfIdle();
    }

    /** Resolve once the queue is empty and no frame work remains. Resolves
     * immediately when already idle; resolves (not hangs) on cancel(). */
    whenIdle() {
        if (!this._queue.length && !this._running) return Promise.resolve();
        return new Promise((resolve) => this._idleWaiters.push(resolve));
    }

    /** Abandon all pending work. Already-appended nodes are left in the DOM
     * (removing them is the caller's teardown job, e.g. clearRightPanel). */
    cancel() {
        this._cancelled = true;
        this._queue.length = 0;
        // Invalidate a possibly-already-scheduled tick: waiting for it to
        // fire would hang whenIdle() forever if frames stop coming (an
        // inactive tab pauses rAF), and the panel is being torn down anyway.
        this._tickGen += 1;
        this._running = false;
        this._finishIfIdle();
    }

    _start() {
        if (this._running || this._cancelled || !this._queue.length) return;
        this._running = true;
        const gen = ++this._tickGen;
        this._schedule(() => this._tick(gen));
    }

    _tick(gen) {
        // A stale tick (drainSync or a newer cycle already consumed this
        // generation) exits without touching state or scheduling more.
        if (gen !== this._tickGen) return;
        if (this._cancelled) {
            this._running = false;
            this._finishIfIdle();
            return;
        }
        this._fillOneFrame(this._max);
        if (this._cancelled) {
            this._running = false;
            this._finishIfIdle();
            return;
        }
        if (this._queue.length) {
            const next = ++this._tickGen;
            this._schedule(() => this._tick(next));
        } else {
            this._running = false;
            this._finishIfIdle();
        }
    }

    _fillOneFrame(maxNodes) {
        const start = nowMs();
        const appended = [];
        while (this._queue.length && appended.length < maxNodes) {
            // The budget check runs after at least one node, so a single
            // slow build can overrun one frame but never stall the filler.
            if (appended.length && nowMs() - start >= this._budget) break;
            const item = this._queue.shift();
            let node = null;
            try {
                node = this._build(item);
            } catch (err) {
                console.error("ChunkedFiller: build failed for item", item, err);
            }
            if (!node) continue;
            try {
                this._appendNode(node);
            } catch (err) {
                console.error("ChunkedFiller: append failed", err);
                continue;
            }
            appended.push(node);
        }
        if (appended.length && this._onBatch) {
            try {
                this._onBatch(appended);
            } catch (err) {
                console.error("ChunkedFiller: onBatch failed", err);
            }
        }
    }

    _finishIfIdle() {
        if (this._queue.length || this._running) return;
        const waiters = this._idleWaiters;
        this._idleWaiters = [];
        for (const resolve of waiters) resolve();
    }
}

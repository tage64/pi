/**
 * Local pi-tools feature: make model throughput and stalled streams visible
 * in the interactive UI. Live rates are estimates because exact output token
 * usage is only available when a stream finishes. Agent requests are combined
 * per run so tool execution and time to first token do not dilute the result.
 */

export type TokenRateSource = "agent" | "compaction";

export interface TokenRateState {
	/** `"live"` during streaming; `"settled"` retains the exact final rate. */
	kind: "live" | "settled" | "none";
	/** Whether the stream received a delta recently; drives the row spinner. */
	flowing: boolean;
	/** Rate text, e.g. `"tps ~120 tok/s"` (live estimate) or `"tps 441 tok/s"` (settled exact). */
	text: string;
	/** Which stream emitted this state; undefined only for the initial idle state. */
	source?: TokenRateSource;
}

export type TokenRateListener = (state: TokenRateState) => void;

const NONE: TokenRateState = { kind: "none", flowing: false, text: "" };

/** Sliding window length for the live estimate. */
const WINDOW_MS = 15_000;
/** Delta silences longer than this freeze the text instead of decaying toward zero. */
const STALL_MS = 2_000;
/** Deltas older than this count the stream as not flowing; the row spinner freezes. */
const FLOW_FRESH_MS = 400;
/** Live update cadence. */
const TICK_MS = 250;
/** Minimum sample span for a meaningful window. */
const MIN_SPAN_MS = 30;
/** Starting chars-per-token heuristic (code/English mix). */
const INITIAL_CHARS_PER_TOKEN = 3.6;
/** Clamp for observed chars-per-token (CJK ≈ 2, prose ≈ 4, pathological ≈ 8). */
const MIN_CHARS_PER_TOKEN = 1;
const MAX_CHARS_PER_TOKEN = 8;
/** EMA weight given to the newest observed chars-per-token. */
const CPT_LEARNING_RATE = 0.5;

interface StreamSample {
	t: number;
	cumTok: number;
}

/**
 * Render a value with exactly `figures` significant figures (e.g. 116 -> "120"
 * at 2 figures, 0.453 -> "0.45"). Non-positive or non-finite values become "0".
 */
function significantDigits(value: number, figures: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	const scale = 10 ** (Math.floor(Math.log10(value)) - figures + 1);
	const rounded = Math.round(value / scale) * scale;
	// Rounding can bump the magnitude (9.97 -> "10"), so re-derive the exponent.
	const decimals = Math.max(0, figures - 1 - Math.floor(Math.log10(rounded)));
	return rounded.toFixed(decimals);
}

/**
 * Settled (exact) rates keep at least two significant figures: integers from
 * ten up keep every digit, one-digit rates keep one decimal, rates below one
 * token per second keep two significant figures so they do not display as 0.
 */
function formatRate(tokensPerSecond: number): string {
	if (tokensPerSecond >= 10) return `${Math.round(tokensPerSecond)} tok/s`;
	return `${significantDigits(tokensPerSecond, 2)} tok/s`;
}

/** Live rates are estimates, so they carry a `~` and exactly two significant figures. */
function formatRateEstimate(tokensPerSecond: number): string {
	return `~${significantDigits(tokensPerSecond, 2)} tok/s`;
}

export class TokenRateMeter {
	private samples: StreamSample[] = [];
	private chars = 0;
	private charsPerTok = INITIAL_CHARS_PER_TOKEN;
	private source: TokenRateSource | undefined;
	private firstDeltaMs: number | undefined;
	private lastDeltaMs = 0;
	private counting = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private listeners = new Set<TokenRateListener>();
	private lastState: TokenRateState = NONE;
	// Run aggregate: settled agent requests of the current run, printed once
	// when control returns to the user. Never cleared by reset(); only by
	// takeRunAggregate() / resetRunTotals().
	private runOutputs = 0;
	private runGenMs = 0;
	private runCount = 0;

	subscribe(listener: TokenRateListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * Feed streamed delta characters from `source`. Measurement begins on the
	 * first call: timing starts at the first visible delta, so TTFT and the
	 * prefill burst are excluded from the rate.
	 */
	delta(source: TokenRateSource, charCount: number): void {
		if (this.source !== source || !this.counting) {
			// A fresh stream (or a retried attempt of one) replaces the old window.
			this.stopTimer();
			this.samples = [];
			this.chars = 0;
			this.firstDeltaMs = undefined;
			this.lastDeltaMs = 0;
			this.source = source;
		}
		const t = performance.now();
		if (this.firstDeltaMs === undefined) this.firstDeltaMs = t;
		this.chars += charCount;
		this.samples.push({ t, cumTok: this.chars / this.charsPerTok });
		this.lastDeltaMs = t;
		this.counting = true;
		if (this.timer === undefined) {
			this.timer = setInterval(this.tick, TICK_MS);
		}
	}

	/**
	 * Stream finished with an exact usage count: reset the live display. Agent
	 * requests accumulate into the run aggregate (see {@link takeRunAggregate});
	 * aborted and failed streams go through {@link discard} and contribute
	 * nothing.
	 */
	settle(source: TokenRateSource, outputTokens: number): void {
		if (this.source !== source || !this.counting) return;
		const genMs = this.firstDeltaMs === undefined ? 0 : this.lastDeltaMs - this.firstDeltaMs;
		if (genMs <= 0 || outputTokens <= 0 || this.chars <= 0) {
			// Nothing measurable; drop the live display rather than show a stale rate.
			this.discard(source);
			return;
		}
		if (source === "agent") {
			this.runOutputs += outputTokens;
			this.runGenMs += genMs;
			this.runCount++;
		}
		// Learn the chars-per-token factor so the next stream's estimate starts closer.
		if (this.chars > 0) {
			const observed = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, this.chars / outputTokens));
			this.charsPerTok = this.charsPerTok * (1 - CPT_LEARNING_RATE) + observed * CPT_LEARNING_RATE;
		}
		const text = `tps ${formatRate(outputTokens / (genMs / 1000))}`;
		this.reset();
		this.emit({ kind: "settled", flowing: false, text, source });
	}

	/** Stream finished without a settle-worthy result (abort/error): drop the display. */
	discard(source: TokenRateSource): void {
		if (this.source !== source || !this.counting) return;
		this.reset();
		this.emit({ kind: "none", flowing: false, text: "", source });
	}

	/** Forget the current run aggregate without printing it (start of a new run). */
	resetRunTotals(): void {
		this.runOutputs = 0;
		this.runGenMs = 0;
		this.runCount = 0;
	}

	/**
	 * Aggregate over the settled agent requests of the current run: total
	 * output tokens divided by total generation time — tool execution and TTFT
	 * are never part of either side. Reading and clearing are one operation;
	 * returns `undefined` when no agent request was measurable this run.
	 */
	takeRunAggregate(): { text: string } | undefined {
		if (this.runCount === 0 || this.runGenMs <= 0 || this.runOutputs <= 0) {
			this.resetRunTotals();
			return undefined;
		}
		const text = `tps ${formatRate(this.runOutputs / (this.runGenMs / 1000))}${
			this.runCount > 1 ? ` · ${this.runCount} requests` : ""
		}`;
		this.resetRunTotals();
		return { text };
	}

	private reset(): void {
		this.stopTimer();
		this.samples = [];
		this.chars = 0;
		this.firstDeltaMs = undefined;
		this.lastDeltaMs = 0;
		this.counting = false;
		this.source = undefined;
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private tick = (): void => {
		if (!this.counting || this.source === undefined) {
			this.stopTimer();
			return;
		}
		const nowMs = performance.now();
		const idleMs = nowMs - this.lastDeltaMs;
		if (idleMs > STALL_MS) return; // provider stall: freeze text and spinner, do not decay
		this.samples = pruneSamples(this.samples, nowMs, WINDOW_MS);
		const rate = instantaneousRate(this.samples, MIN_SPAN_MS);
		if (rate !== null) {
			this.emit({
				kind: "live",
				flowing: idleMs <= FLOW_FRESH_MS,
				text: `tps ${formatRateEstimate(rate)}`,
				source: this.source ?? undefined,
			});
		} else if (this.lastState.kind === "live") {
			// No window yet: still reflect spinner flow transitions.
			this.emit({
				kind: "live",
				flowing: idleMs <= FLOW_FRESH_MS,
				text: this.lastState.text,
				source: this.source ?? undefined,
			});
		}
	};

	private emit(state: TokenRateState): void {
		if (
			state.kind === this.lastState.kind &&
			state.flowing === this.lastState.flowing &&
			state.text === this.lastState.text &&
			state.source === this.lastState.source
		) {
			return;
		}
		this.lastState = state;
		for (const listener of this.listeners) listener(state);
	}
}

/** Drop samples older than the sliding window, keeping only the active tail. */
function pruneSamples(samples: StreamSample[], nowMs: number, windowMs: number): StreamSample[] {
	const cutoff = nowMs - windowMs;
	let firstKept = 0;
	while (firstKept < samples.length && samples[firstKept].t < cutoff) firstKept++;
	return firstKept === 0 ? samples : samples.slice(firstKept);
}

/** Output rate over the trailing samples, or null when the span is too short. */
function instantaneousRate(samples: StreamSample[], minSpanMs: number): number | null {
	const oldest = samples[0];
	const newest = samples[samples.length - 1];
	if (!oldest || !newest || newest === oldest) return null;
	const dtMs = newest.t - oldest.t;
	const dTok = newest.cumTok - oldest.cumTok;
	if (dtMs < minSpanMs || dTok <= 0) return null;
	return (dTok / dtMs) * 1000;
}

/** Process-wide meter; interactive mode subscribes to render the display. */
export const tokenRateMeter = new TokenRateMeter();

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TokenRateMeter, type TokenRateState } from "../src/core/token-rate-meter.ts";

describe("TokenRateMeter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("emits live estimates while a stream is producing tokens", () => {
		const meter = new TokenRateMeter();
		const states: TokenRateState[] = [];
		meter.subscribe((state) => states.push({ ...state }));

		meter.delta("agent", 100);
		vi.advanceTimersByTime(80);
		meter.delta("agent", 100);
		vi.advanceTimersByTime(700);

		const live = states.filter((state) => state.kind === "live");
		expect(live.length).toBeGreaterThan(0);
		expect(live.at(-1)?.text).toMatch(/^tps ~\d+ tok\/s$/);
		// A quiet stream freezes the spinner instead of implying continued output.
		expect(states.some((state) => state.kind === "live" && !state.flowing)).toBe(true);
	});

	test("settles to the exact rate from final usage", () => {
		const meter = new TokenRateMeter();
		const states: TokenRateState[] = [];
		meter.subscribe((state) => states.push({ ...state }));

		meter.delta("agent", 60);
		vi.advanceTimersByTime(60);
		meter.delta("agent", 60);
		meter.settle("agent", 24);

		const settled = states.find((state) => state.kind === "settled");
		expect(settled).toMatchObject({ kind: "settled", text: "tps 400 tok/s", source: "agent" });
		// Settling stops the loop: no further live states are emitted.
		const settledIndex = states.findIndex((state) => state.kind === "settled");
		vi.advanceTimersByTime(300);
		expect(states.length).toBe(settledIndex + 1);
	});

	test("aggregates agent requests per run and consumes once", () => {
		const meter = new TokenRateMeter();
		expect(meter.takeRunAggregate()).toBeUndefined();

		meter.delta("agent", 50);
		vi.advanceTimersByTime(60);
		meter.delta("agent", 50);
		meter.settle("agent", 30);

		meter.delta("agent", 50);
		vi.advanceTimersByTime(60);
		meter.delta("agent", 50);
		meter.settle("agent", 90);

		expect(meter.takeRunAggregate()?.text).toBe("tps 1000 tok/s · 2 requests");
		expect(meter.takeRunAggregate()).toBeUndefined();
	});

	test("compaction settles do not feed the run aggregate", () => {
		const meter = new TokenRateMeter();
		meter.delta("compaction", 100);
		vi.advanceTimersByTime(60);
		meter.delta("compaction", 100);
		meter.settle("compaction", 500);
		expect(meter.takeRunAggregate()).toBeUndefined();
		// Aborts still clear the live display for their own source.
		meter.discard("agent");
		expect(meter.takeRunAggregate()).toBeUndefined();
	});

	test("discards a failed stream and restarts cleanly on the next one", () => {
		const meter = new TokenRateMeter();
		const states: TokenRateState[] = [];
		meter.subscribe((state) => states.push({ ...state }));

		meter.delta("agent", 50);
		vi.advanceTimersByTime(80);
		meter.delta("agent", 50);
		vi.advanceTimersByTime(300);
		meter.discard("agent");
		expect(states.at(-1)?.kind).toBe("none");
		// Settle must be ignored for the discarded stream.
		meter.settle("agent", 10);
		expect(states.at(-1)?.kind).toBe("none");

		meter.delta("agent", 50);
		vi.advanceTimersByTime(60);
		meter.delta("agent", 50);
		vi.advanceTimersByTime(500);
		expect(states.at(-1)?.kind).toBe("live");
		expect(states.some((state) => state.kind === "settled")).toBe(false);
	});

	test("publishes identical rates from different sources", () => {
		const meter = new TokenRateMeter();
		const states: TokenRateState[] = [];
		meter.subscribe((state) => states.push({ ...state }));

		meter.delta("agent", 60);
		vi.advanceTimersByTime(60);
		meter.delta("agent", 60);
		meter.settle("agent", 60);
		meter.delta("compaction", 60);
		vi.advanceTimersByTime(60);
		meter.delta("compaction", 60);
		meter.settle("compaction", 60);

		expect(states.filter((state) => state.kind === "settled").map((state) => state.source)).toEqual([
			"agent",
			"compaction",
		]);
	});
});

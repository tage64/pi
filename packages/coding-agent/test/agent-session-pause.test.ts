import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AgentSession pause", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-pause-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, args) => {
			const { text } = args as { text: string };
			return { content: [{ type: "text", text: `echoed: ${text}` }], details: undefined };
		},
	};

	/**
	 * Creates a session whose first LLM call issues a tool call and whose second
	 * call returns a final text answer. Returns the call count getter so tests can
	 * assert exactly when the second provider request fires.
	 */
	async function createToolLoopSession() {
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount === 1) {
						const msg: AssistantMessage = {
							...createAssistantMessage("Looking that up now."),
							stopReason: "toolUse",
							content: [
								{ type: "text", text: "Looking that up now." },
								{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hello" } },
							],
						};
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "toolUse", message: msg });
					} else {
						const msg = createAssistantMessage("Final answer.");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			baseToolsOverride: { echo: echoTool },
		});

		return { session, getCallCount: () => callCount };
	}

	it("suspends the run at the turn boundary until resumed", async () => {
		const created = await createToolLoopSession();
		const events: AgentSessionEvent[] = [];
		created.session.subscribe((event) => {
			if (event.type === "pause_start" || event.type === "pause_end") {
				events.push(event);
			}
		});

		const promptPromise = created.session.prompt("Test");
		created.session.pause();
		expect(created.session.pauseRequested).toBe(true);

		// Wait for the pause to take effect: the first turn (assistant message +
		// tool call) completes, then the run suspends before the second LLM call.
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});
		expect(events.map((e) => e.type)).toEqual(["pause_start"]);
		expect(created.getCallCount()).toBe(1);
		expect(created.session.isStreaming).toBe(true);

		// Give the loop a chance to misbehave: no further provider call may happen
		// while paused.
		await sleep(50);
		expect(created.getCallCount()).toBe(1);

		created.session.resume();
		await promptPromise;

		expect(created.getCallCount()).toBe(2);
		expect(events.map((e) => e.type)).toEqual(["pause_start", "pause_end"]);
		expect(created.session.isPaused).toBe(false);
		expect(created.session.pauseRequested).toBe(false);
		expect(created.session.isStreaming).toBe(false);

		// The model saw an uninterrupted transcript: user, tool call, tool result,
		// final answer. No pause-related messages.
		const roles = created.session.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
	});

	it("processes steering messages queued while paused on resume", async () => {
		const created = await createToolLoopSession();

		const promptPromise = created.session.prompt("Test");
		created.session.pause();
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});

		await created.session.steer("Use uppercase next time.");
		created.session.resume();
		await promptPromise;

		// user, tool-call turn, tool result, steering user message, final answer
		const roles = created.session.state.messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
	});

	it("pause requested after the last turn holds back follow-up messages until resume", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage(`Answer ${callCount}`);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		await session.followUp("follow-up question");
		const promptPromise = session.prompt("Test");
		session.pause();

		// The only LLM call so far completes immediately; without the pause gate
		// before the follow-up check, the queued follow-up would start right away.
		await vi.waitFor(() => {
			expect(session.isPaused).toBe(true);
		});
		expect(callCount).toBe(1);

		session.resume();
		await promptPromise;
		expect(callCount).toBe(2);
		expect(session.isStreaming).toBe(false);
	});

	it("abort releases the pause gate and terminates the run", async () => {
		const created = await createToolLoopSession();

		const promptPromise = created.session.prompt("Test");
		created.session.pause();
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});
		expect(created.getCallCount()).toBe(1);

		await created.session.abort();
		await promptPromise;

		expect(created.session.isPaused).toBe(false);
		expect(created.session.pauseRequested).toBe(false);
		expect(created.session.isIdle).toBe(true);

		// After the run settled, no further provider work may happen.
		const callsAfterSettle = created.getCallCount();
		await sleep(50);
		expect(created.getCallCount()).toBe(callsAfterSettle);
		expect(callsAfterSettle).toBeLessThanOrEqual(2);

		// If the second request had already fired when the abort landed, its
		// answer must not have completed successfully.
		const messages = created.session.state.messages;
		const last = messages[messages.length - 1];
		if (last.role === "assistant") {
			expect((last as AssistantMessage).stopReason).not.toBe("stop");
		}
	});

	it("resume is a no-op when not paused; pause requested while idle latches to the next run", async () => {
		const created = await createToolLoopSession();

		created.session.resume();
		expect(created.session.pauseRequested).toBe(false);

		// Requested while idle: latches and applies at the first turn boundary
		// of the next run.
		created.session.pause();
		expect(created.session.pauseRequested).toBe(true);

		const promptPromise = created.session.prompt("Test");
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});
		expect(created.getCallCount()).toBe(1);
		created.session.resume();
		await promptPromise;
		expect(created.getCallCount()).toBe(2);
	});

	it("togglePause toggles between pause request and resume", async () => {
		const created = await createToolLoopSession();

		const promptPromise = created.session.prompt("Test");
		expect(created.session.togglePause()).toBe("pause_requested");
		// Toggling again before the boundary cancels the pause entirely.
		expect(created.session.togglePause()).toBe("resumed");

		await promptPromise;
		expect(created.session.isPaused).toBe(false);
		expect(created.getCallCount()).toBe(2);
	});

	it("abort clears a latched pause request before the next prompt", async () => {
		const created = await createToolLoopSession();
		created.session.pause();
		expect(created.session.pauseRequested).toBe(true);
		// Simulate the user hitting Esc to dismiss the pending pause.
		await created.session.abort();
		expect(created.session.pauseRequested).toBe(false);
		// The next prompt must run to completion without pausing.
		await created.session.prompt("Test");
		expect(created.getCallCount()).toBe(2);
		expect(created.session.isPaused).toBe(false);
		expect(created.session.isStreaming).toBe(false);
	});

	it("clearPauseRequest clears a latched request but not an active pause", async () => {
		const created = await createToolLoopSession();
		// Nothing latched: no-op.
		expect(created.session.clearPauseRequest()).toBe(false);
		created.session.pause();
		expect(created.session.clearPauseRequest()).toBe(true);
		expect(created.session.pauseRequested).toBe(false);

		// Active pause at a turn boundary: clearPauseRequest must not release the
		// gate; only resume() does.
		const promptPromise = created.session.prompt("Test");
		created.session.pause();
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});
		expect(created.session.clearPauseRequest()).toBe(false);
		expect(created.session.isPaused).toBe(true);
		created.session.resume();
		await promptPromise;
		expect(created.getCallCount()).toBe(2);
	});

	it("dispose clears a latched pause request", async () => {
		const created = await createToolLoopSession();
		created.session.pause();
		expect(created.session.pauseRequested).toBe(true);
		created.session.dispose();
		expect(created.session.pauseRequested).toBe(false);
	});

	it("aborted paused run surfaces an aborted assistant message, not a retryable error", async () => {
		const created = await createToolLoopSession();
		const promptPromise = created.session.prompt("Test");
		created.session.pause();
		await vi.waitFor(() => {
			expect(created.session.isPaused).toBe(true);
		});
		await created.session.abort();
		await promptPromise;
		const messages = created.session.state.messages;
		const last = messages[messages.length - 1];
		expect(last.role).toBe("assistant");
		// The abort unwinds through handleRunFailure, marking the synthetic
		// message as aborted - it must not be classified as a provider error.
		expect((last as AssistantMessage).stopReason).toBe("aborted");
	});
});

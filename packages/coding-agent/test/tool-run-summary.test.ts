import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolRunSummaryComponent } from "../src/modes/interactive/components/tool-run-summary.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createToolComponent(toolName: string, toolCallId: string, ui: TUI): ToolExecutionComponent {
	return new ToolExecutionComponent(toolName, toolCallId, {}, { showImages: false }, undefined, ui, process.cwd());
}

function createToolRunSummary(ui: TUI, toolCount: number, results: boolean[]): ToolRunSummaryComponent {
	const summary = new ToolRunSummaryComponent();
	for (let i = 0; i < toolCount; i++) {
		const tool = createToolComponent("bash", `call-${i}`, ui);
		tool.setCollapsed(true);
		summary.addToolComponent(tool);
		if (results[i]) {
			tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		}
	}
	return summary;
}

type RenderSessionItems = (this: Record<string, any>, items: any[], options?: any) => void;

function createAssistantMessage(toolCallIds: string[], timestamp = Date.now()): AssistantMessage {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })),
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function createToolResultMessage(toolCallId: string, timestamp = Date.now()): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

function callRenderSessionItems(
	collapsedToolOutput: boolean,
	items: any[],
): { chatContainer: Container; groups: ToolRunSummaryComponent[] } {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	const chatContainer = new Container();
	const groups: ToolRunSummaryComponent[] = [];
	const fakeThis: Record<string, any> = {
		pendingTools: new Map(),
		activeToolGroup: undefined,
		collapsedToolOutput,
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking...",
		ui,
		chatContainer,
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getCwd: () => process.cwd() },
		getRegisteredToolDefinition: () => undefined,
		addMessageToChat: vi.fn(),
	};
	const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as RenderSessionItems;
	renderSessionItems.call(fakeThis, items);
	for (const child of chatContainer.children as any[]) {
		if (child instanceof ToolRunSummaryComponent) {
			groups.push(child);
		}
	}
	return { chatContainer, groups };
}

describe("renderSessionItems collapsed tool output grouping", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("groups all tool executions of a run into one summary component", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const start = 60_000;
		const { chatContainer, groups } = callRenderSessionItems(true, [
			createAssistantMessage(["call-1", "call-2"], start),
			createToolResultMessage("call-1", start + 1500),
			createToolResultMessage("call-2", start + 4200),
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0]?.getToolComponents()).toHaveLength(2);
		const renderedLines = chatContainer.render(80).map((line) => stripAnsi(line).trim());
		// Duration is derived from persisted message/result timestamps
		expect(renderedLines).toContain("[2 tool calls in 4.2s]");
		// The tool execution output itself must be hidden
		expect(renderedLines.join("\n")).not.toContain("ok");
	});

	test("merges consecutive tool-only assistant messages into one summary", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const start = 10_000;
		const { chatContainer, groups } = callRenderSessionItems(true, [
			{
				...createAssistantMessage(["call-1"], start),
				content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
			},
			createToolResultMessage("call-1", start + 1000),
			createAssistantMessage(["call-2"], start + 2000),
			createToolResultMessage("call-2", start + 4500),
		]);

		// A run continues across assistant messages that contain no visible text
		expect(groups).toHaveLength(1);
		expect(groups[0]?.getToolComponents()).toHaveLength(2);
		const renderedLines = chatContainer.render(80).map((line) => stripAnsi(line).trim());
		expect(renderedLines).toContain("[2 tool calls in 4.5s]");
	});

	test("starts a new summary after assistant text", () => {
		const { groups } = callRenderSessionItems(true, [
			{
				...createAssistantMessage(["call-1"]),
				content: [
					{ type: "text", text: "let me look" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
				],
			},
			createToolResultMessage("call-1"),
			{
				...createAssistantMessage(["call-2"]),
				content: [
					{ type: "text", text: "now editing" },
					{ type: "toolCall", id: "call-2", name: "bash", arguments: {} },
				],
			},
			createToolResultMessage("call-2"),
		]);

		expect(groups).toHaveLength(2);
		expect(groups[0]?.getToolComponents()).toHaveLength(1);
		expect(groups[1]?.getToolComponents()).toHaveLength(1);
	});

	test("keeps tool components ungrouped when the setting is disabled", () => {
		const { chatContainer, groups } = callRenderSessionItems(false, [
			createAssistantMessage(["call-1", "call-2"]),
			createToolResultMessage("call-1"),
			createToolResultMessage("call-2"),
		]);

		expect(groups).toHaveLength(0);
		for (const child of chatContainer.children as any[]) {
			expect(child instanceof ToolExecutionComponent).toBe(true);
			const rendered = stripAnsi(child.render(80).join("\n"));
			expect(rendered).toContain("ok");
		}
	});
});

describe("collapseRunningToolOutput", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	function callCollapseRunningToolOutput(chatContainer: Container): Record<string, any> {
		const fakeThis: Record<string, any> = { chatContainer, activeToolGroup: undefined };
		const collapse = Reflect.get(InteractiveMode.prototype, "collapseRunningToolOutput") as (
			this: Record<string, any>,
		) => void;
		collapse.call(fakeThis);
		return fakeThis;
	}

	test("only groups the trailing run of tool components", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const historyTool = createToolComponent("bash", "hist-1", ui);
		const runToolA = createToolComponent("bash", "run-1", ui);
		const runToolB = createToolComponent("bash", "run-2", ui);
		chatContainer.addChild(new Text("previous turn", 0, 0));
		chatContainer.addChild(historyTool);
		chatContainer.addChild(new Text("assistant reply", 0, 0));
		chatContainer.addChild(runToolA);
		chatContainer.addChild(runToolB);

		const fakeThis = callCollapseRunningToolOutput(chatContainer);

		// Tools from earlier turns stay direct children, outside the group
		expect(chatContainer.children).toContain(historyTool);
		const group = fakeThis.activeToolGroup as ToolRunSummaryComponent;
		expect(group.getToolComponents()).toEqual([runToolA, runToolB]);
		// The summary stays where the active run was: at the end of the chat
		expect(chatContainer.children[chatContainer.children.length - 1]).toBe(group);
	});

	test("does nothing when no tool run is active", () => {
		const chatContainer = new Container();
		chatContainer.addChild(new Text("just text", 0, 0));

		const fakeThis = callCollapseRunningToolOutput(chatContainer);

		expect(fakeThis.activeToolGroup).toBeUndefined();
		expect(chatContainer.children).toHaveLength(1);
	});
});

describe("ToolRunSummaryComponent", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("renders [] for collapsed tool execution components", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const tool = createToolComponent("bash", "call-1", ui);
		tool.updateResult({ content: [{ type: "text", text: "secret output" }], isError: false });

		tool.setCollapsed(true);
		expect(tool.render(120)).toEqual([]);

		tool.setCollapsed(false);
		expect(stripAnsi(tool.render(120).join("\n"))).toContain("secret output");
	});

	test("shows pending progress without seconds while tools are running", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const summary = createToolRunSummary(ui, 3, [true, false, false]);

		const lines = stripAnsi(summary.render(80).join("\n"));
		expect(lines).toContain("[1/3 tools]");
		// No seconds while pending
		expect(lines).not.toContain("·");
		expect(lines).not.toContain("secret");
	});

	test("shows settled summary with duration once all tools have results", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const ui = { requestRender: vi.fn() } as unknown as TUI;

		vi.advanceTimersByTime(2000);
		const summary = createToolRunSummary(ui, 2, []);
		const toolOne = summary.getToolComponents()[0];
		const toolTwo = summary.getToolComponents()[1];

		vi.advanceTimersByTime(3000);
		toolOne?.updateResult({ content: [{ type: "text", text: "one" }], isError: false });
		expect(stripAnsi(summary.render(80).join("\n"))).toContain("[1/2 tools");

		vi.advanceTimersByTime(2000);
		toolTwo?.updateResult({ content: [{ type: "text", text: "two" }], isError: false });
		const settled = stripAnsi(summary.render(80).join("\n"));
		expect(settled).toContain("[2 tool calls in 5.0s]");
		expect(settled).not.toContain("/");

		// The summary line replaces the tool output entirely
		expect(settled).not.toContain("one");
		expect(settled).not.toContain("two");
	});

	test("forceComplete settles summaries whose tools never returned", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const summary = createToolRunSummary(ui, 1, [false]);
		summary.forceComplete();

		const lines = stripAnsi(summary.render(80).join("\n"));
		expect(lines).toContain("[1 tool call]");
		expect(lines).not.toContain("1/1");
	});

	test("renders without duration when the tracked run is too short to be meaningful", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const summary = createToolRunSummary(ui, 1, [true]);

		const lines = stripAnsi(summary.render(80).join("\n"));
		expect(lines).toContain("[1 tool call]");
	});
});

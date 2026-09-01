import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

function formatToolDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact replacement for a run of tool executions. While tools are pending it
 * renders a progress line like "[2/5 tools]"; once every tool has a result it
 * renders the settled summary "[5 tool calls in 54.0s]". The individual
 * ToolExecutionComponents inside it are hidden by collapsing them.
 */
export class ToolRunSummaryComponent extends Container {
	private readonly summaryText: Text;
	private readonly launchedAt: number;
	private lastResultAt: number | undefined;
	private finishedAt: number | undefined;
	private forceFinished = false;

	constructor(launchedAt = Date.now()) {
		super();
		this.launchedAt = launchedAt;
		this.summaryText = new Text("", 1, 0);
		this.addChild(new Spacer(1));
		this.addChild(this.summaryText);
	}

	addToolComponent(component: ToolExecutionComponent): void {
		this.addChild(component);
	}

	/** Feed a persisted tool result completion time; used when rebuilding from session history. */
	noteResultTimestamp(timestamp: number | undefined): void {
		if (timestamp === undefined) return;
		this.lastResultAt = this.lastResultAt === undefined ? timestamp : Math.max(this.lastResultAt, timestamp);
	}

	getToolComponents(): ToolExecutionComponent[] {
		return this.children.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent);
	}

	/** Whether any tracked tool is still awaiting its final result. */
	hasPendingTools(): boolean {
		return this.getToolCounts().pending > 0;
	}

	/** Force the summary into its settled state (aborted or dropped runs). */
	forceComplete(): void {
		this.finishedAt ??= Date.now();
		this.forceFinished = true;
	}

	override render(width: number): string[] {
		this.refreshSummaryText();
		return super.render(width);
	}

	private getToolCounts(): { total: number; pending: number } {
		const tools = this.getToolComponents();
		let pending = 0;
		for (const tool of tools) {
			if (!tool.hasResult()) pending++;
		}
		return { total: tools.length, pending: this.forceFinished ? 0 : pending };
	}

	private refreshSummaryText(): void {
		const { total, pending } = this.getToolCounts();
		if (total === 0) {
			this.summaryText.setText("");
			return;
		}

		if (pending > 0) {
			this.summaryText.setText(theme.fg("muted", `[${total - pending}/${total} tool${total === 1 ? "" : "s"}]`));
			return;
		}

		if (this.finishedAt === undefined) {
			// Prefer persisted result timestamps (stable across restarts); fall back
			// to the wall clock at settle time for live runs.
			this.finishedAt = this.lastResultAt ?? Date.now();
		}
		const durationMs = Math.max(0, this.finishedAt - this.launchedAt);
		const duration = durationMs >= 100 ? ` in ${formatToolDuration(durationMs)}` : "";
		this.summaryText.setText(theme.fg("muted", `[${total} tool call${total === 1 ? "" : "s"}${duration}]`));
	}
}

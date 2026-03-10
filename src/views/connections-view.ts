/**
 * Connections View - 右侧关联推荐视图
 *
 * 职责：
 * - 监听当前活动文件的变化
 * - 调用 ConnectionsService 获取相关笔记
 * - 渲染关联结果列表（标题 + 路径 + 分数 + 最佳 passage）
 * - 仅负责 UI 渲染，核心逻辑在 search/ 中
 */

import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { ConnectionResult } from "../types";
import { debounce } from "../utils/debounce";

/** 视图类型标识符 */
export const VIEW_TYPE_CONNECTIONS = "semantic-connections-view";

export class ConnectionsView extends ItemView {
	private plugin: SemanticConnectionsPlugin;
	/** 防止重复渲染的标记 */
	private currentNotePath: string = "";
	private refreshRequestId = 0;
	private scheduleRefresh = debounce((force: boolean = false) => {
		void this.refreshView(force);
	}, 300);

	constructor(leaf: WorkspaceLeaf, plugin: SemanticConnectionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CONNECTIONS;
	}

	getDisplayText(): string {
		return "语义关联";
	}

	getIcon(): string {
		return "git-compare";
	}

	async onOpen(): Promise<void> {
		// 监听活动文件切换
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.refreshView();
			}),
		);

		// 当前文件内容更新时刷新结果
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (file.path !== this.currentNotePath) return;
				this.scheduleRefresh(true);
			}),
		);

		// 初次打开时渲染
		this.refreshView();
	}

	async onClose(): Promise<void> {
		this.currentNotePath = "";
		this.refreshRequestId++;
	}

	/**
	 * 刷新视图
	 * 获取当前活动文件，查询关联结果并渲染
	 */
	private async refreshView(force = false): Promise<void> {
		const file = this.app.workspace.getActiveFile();

		// 无活动文件或非 md 文件
		if (!file || file.extension !== "md") {
			this.refreshRequestId++;
			this.renderEmpty("打开一篇笔记以查看语义关联");
			this.currentNotePath = "";
			return;
		}

		// 避免重复查询同一文件
		if (!force && file.path === this.currentNotePath) return;
		this.currentNotePath = file.path;
		const requestId = ++this.refreshRequestId;

		// 检查索引状态
		if (this.plugin.noteStore.size === 0) {
			this.renderEmpty("索引为空，请先执行「重建索引」命令");
			return;
		}

		// 查询关联结果
		this.renderLoading();
		try {
			const results = await this.plugin.connectionsService.findConnections(
				file.path,
				this.plugin.settings.maxConnections,
			);
			if (this.isStaleRequest(requestId, file.path)) return;

			if (results.length === 0) {
				this.renderEmpty("暂未找到相关笔记");
			} else {
				this.renderResults(results);
			}
		} catch (err) {
			if (this.isStaleRequest(requestId, file.path)) return;
			console.error("ConnectionsView: query failed", err);
			await this.plugin.logRuntimeError("connections-query", err, {
				errorType: "query",
				filePath: file.path,
				details: [
					`force_refresh=${force}`,
					`max_results=${this.plugin.settings.maxConnections}`,
				],
			});
			this.renderEmpty("查询失败，请查看控制台");
		}
	}

	private isStaleRequest(requestId: number, expectedPath: string): boolean {
		if (requestId !== this.refreshRequestId) {
			return true;
		}
		const activeFile = this.app.workspace.getActiveFile();
		return !activeFile || activeFile.path !== expectedPath;
	}

	/** 渲染空状态 */
	private renderEmpty(message: string): void {
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	/** 渲染加载中状态 */
	private renderLoading(): void {
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: "正在查询...", cls: "sc-placeholder-text" });
	}

	/** 渲染关联结果列表 */
	private renderResults(results: ConnectionResult[]): void {
		const container = this.containerEl.children[1];
		container.empty();

		const list = container.createEl("div", { cls: "sc-results-list" });

		for (const result of results) {
			this.renderResultItem(list, result);
		}
	}

	/**
	 * 渲染单条关联结果
	 * 包含：标题、相似度、路径、最佳 passage 摘要
	 */
	private renderResultItem(parent: Element, result: ConnectionResult): void {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		// 标题行（可点击打开笔记）
		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (e) => {
			e.preventDefault();
			this.app.workspace.openLinkText(result.notePath, "", false);
		});

		// 相似度分数
		const scoreEl = header.createEl("span", {
			text: `${(result.score * 100).toFixed(1)}%`,
			cls: "sc-result-score",
		});
		scoreEl.setAttr(
			"title",
			`综合 ${(result.score * 100).toFixed(1)}% | note ${(result.noteScore * 100).toFixed(1)}% | passage ${(result.passageScore * 100).toFixed(1)}%`,
		);

		// 文件路径
		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});

		// 最佳 passage
		if (result.bestPassage) {
			const passageEl = item.createEl("div", { cls: "sc-result-passage" });

			if (result.bestPassage.heading) {
				passageEl.createEl("div", {
					text: result.bestPassage.heading,
					cls: "sc-passage-heading",
				});
			}

			// 截断显示，避免过长
			const previewText = result.bestPassage.text.length > 200
				? result.bestPassage.text.slice(0, 200) + "..."
				: result.bestPassage.text;

			passageEl.createEl("div", {
				text: previewText,
				cls: "sc-passage-text",
			});
		}
	}
}

/**
 * ConnectionsView - 右侧栏“关联视图”（Semantic Connections）。
 *
 * 这个 view 负责把 `ConnectionsService.findConnections()` 的结果展示出来：
 * - 显示与当前笔记最相关的其它笔记列表
 * - 为每条结果展示“最契合段落”预览
 * - 点击结果：在主编辑区打开目标笔记，并高亮对应段落范围（ChunkMeta.range）
 *
 * UI 更新触发源：
 * - 活动叶子变化：当前笔记变了 → 重新查询
 * - 索引版本变化：索引数据变了 → 重新查询
 * - 当前笔记被修改：debounce 后刷新（避免每次敲键都刷新）
 *
 * 一致性处理：
 * - 使用 `refreshRequestId` 丢弃过期请求，避免异步查询结果乱序覆盖 UI。
 */
import { Component, ItemView, MarkdownRenderer, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { ConnectionResult } from "../types";
import { debounce } from "../utils/debounce";

/** Obsidian 用来识别 view 的 type 字符串（注册/激活视图时使用）。 */
export const VIEW_TYPE_CONNECTIONS = "semantic-connections-view";

/**
 * ConnectionsView 实例对应一个 leaf（通常位于右侧栏）。
 *
 * 注意：当右侧栏 view 成为 active leaf 时，`workspace.getActiveFile()` 可能为 null，
 * 因此本 view 内部会维护 `lastMarkdownFile` 作为回退目标（详见 getTargetFile）。
 */
export class ConnectionsView extends ItemView {
	/** 主插件实例：用于访问 settings、service/store，并记录日志。 */
	private plugin: SemanticConnectionsPlugin;
	/** 当前正在展示关联结果的笔记路径（用于避免重复刷新）。 */
	private currentNotePath = "";
	/** 记录最近一次活跃的 Markdown 文件（用于右侧栏成为 active 时的回退）。 */
	private lastMarkdownFile: TFile | null = null;
	/** 用于判断索引是否更新：如果 indexVersion 未变且 notePath 未变，则不刷新。 */
	private currentIndexVersion = -1;
	/** 每次 refreshView 都会递增，用于丢弃过期请求的结果（防竞态）。 */
	private refreshRequestId = 0;
	/** 关联结果预览渲染时创建的子组件，刷新时统一卸载避免泄漏。 */
	private previewRenderChildren: Component[] = [];
	/** 对高频事件（如 modify）做 debounce，避免 UI 抖动与重复查询。 */
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

	/**
	 * view 打开时触发：
	 * - 监听 active leaf 变化（当前笔记切换）
	 * - 监听当前笔记 modify（编辑时刷新）
	 * - 首次渲染
	 */
	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const view = leaf?.view;
				if (view instanceof MarkdownView && view.file) {
					this.lastMarkdownFile = view.file;
				}
				void this.refreshView();
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				if (file.path !== this.currentNotePath) {
					return;
				}
				this.scheduleRefresh(true);
			}),
		);

		await this.refreshView();
	}

	/**
	 * view 关闭时触发：清理状态，并让未完成的异步 refresh 失效。
	 */
	async onClose(): Promise<void> {
		this.scheduleRefresh.cancel();
		this.clearPreviewRenderChildren();
		this.currentNotePath = "";
		this.lastMarkdownFile = null;
		this.currentIndexVersion = -1;
		this.refreshRequestId++;
	}

	/**
	 * main.ts 在索引版本变化时会调用（通过 bumpIndexVersion 通知）。
	 * 这里直接触发刷新即可。
	 */
	onIndexVersionChanged(_version: number, _reason: string): void {
		void this.refreshView();
	}

	/** 供外部在设置变更后主动触发刷新。 */
	async refreshNow(force = false): Promise<void> {
		await this.refreshView(force);
	}

	/**
	 * 刷新 view 内容：
	 * 1) 获取当前目标文件（编辑区当前笔记）
	 * 2) 判断是否需要刷新（force/indexVersion/notePath）
	 * 3) 调用 ConnectionsService 查询
	 * 4) 渲染结果/空状态/错误状态
	 *
	 * `refreshRequestId` 用于解决竞态：当用户快速切换笔记时，旧请求返回的结果会被丢弃。
	 */
	private async refreshView(force = false): Promise<void> {
		const file = this.getTargetFile();

		if (!file || file.extension !== "md") {
			this.refreshRequestId++;
			this.currentNotePath = "";
			this.currentIndexVersion = -1;
			this.renderEmpty("打开一篇笔记以查看语义关联。", null);
			return;
		}

		const indexVersion = this.plugin.indexVersion;
		if (
			!force &&
			file.path === this.currentNotePath &&
			indexVersion === this.currentIndexVersion
		) {
			return;
		}
		this.currentNotePath = file.path;
		this.currentIndexVersion = indexVersion;
		const requestId = ++this.refreshRequestId;

		if (this.plugin.noteStore.size === 0) {
			this.renderEmpty("索引为空，请先执行“重建索引”。", file);
			return;
		}

		this.renderLoading(file);
		try {
			const results = await this.plugin.connectionsService.findConnections(
				file.path,
				this.plugin.settings.maxConnections,
				{
					minSimilarityScore: this.plugin.settings.minSimilarityScore,
					maxPassagesPerNote: this.plugin.settings.maxPassagesPerNote,
					excludedFolders: this.plugin.settings.excludedFolders,
				},
			);
			if (this.isStaleRequest(requestId, file.path)) {
				return;
			}

			if (results.length === 0) {
				this.renderEmpty(
					"暂无关联笔记。建议尝试同步更多笔记或调整相关度阈值。",
					file,
				);
			} else {
				await this.renderResults(results, file);
			}
		} catch (err) {
			if (this.isStaleRequest(requestId, file.path)) {
				return;
			}
			console.error("ConnectionsView: query failed", err);
			await this.plugin.logRuntimeError("connections-query", err, {
				errorType: "query",
				filePath: file.path,
				details: [
					`force_refresh=${force}`,
					`max_results=${this.plugin.settings.maxConnections}`,
				],
			});
			this.renderEmpty("加载关联结果失败，请检查控制台或日志。", file);
		}
	}

	/**
	 * When this view is in the right sidebar, it can become the active leaf.
	 * `workspace.getActiveFile()` would then be null, so we fall back to the most
	 * recently active leaf in the root split (the editor area).
	 */
	private getTargetFile(): TFile | null {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) {
			this.lastMarkdownFile = activeFile;
			return activeFile;
		}

		if (this.lastMarkdownFile) {
			return this.lastMarkdownFile;
		}

		const recentLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		if (!recentLeaf) {
			return null;
		}

		const view = recentLeaf.view;
		if (view instanceof MarkdownView) {
			if (view.file) {
				this.lastMarkdownFile = view.file;
			}
			return view.file ?? null;
		}

		return null;
	}

	private isStaleRequest(requestId: number, expectedPath: string): boolean {
		if (requestId !== this.refreshRequestId) {
			return true;
		}
		const file = this.getTargetFile();
		return !file || file.path !== expectedPath;
	}

	/** 渲染空状态（未打开笔记/无结果/索引为空/出错等）。 */
	private renderEmpty(message: string, file: TFile | null): void {
		const container = this.prepareContainer(file);
		container
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	/** 渲染加载状态（显示 spinner）。 */
	private renderLoading(file: TFile): void {
		const container = this.prepareContainer(file);
		const placeholder = container.createEl("div", { cls: "sc-placeholder sc-loading" });
		placeholder.createEl("div", { cls: "sc-loading-spinner", attr: { "aria-label": "loading" } });
		placeholder.createEl("p", {
			text: "正在搜索关联笔记...",
			cls: "sc-placeholder-text",
		});
	}

	/** 渲染关联结果列表。 */
	private async renderResults(results: ConnectionResult[], file: TFile): Promise<void> {
		const container = this.prepareContainer(file);

		const list = container.createEl("div", { cls: "sc-results-list" });
		await Promise.all(results.map((result) => this.renderResultItem(list, result)));
	}

	/**
	 * 每次渲染前清空 contentEl，并根据 noteStore 的 dirty/outdated 状态决定是否显示提示条。
	 */
	private prepareContainer(file: TFile | null): HTMLElement {
		const container = this.contentEl;
		this.clearPreviewRenderChildren();
		container.empty();

		if (file) {
			const meta = this.plugin.noteStore.get(file.path);
			if (meta?.dirty || meta?.outdated) {
				this.renderDirtyBanner(container, file);
			}
		}

		return container;
	}

	private clearPreviewRenderChildren(): void {
		for (const child of this.previewRenderChildren) {
			child.unload();
		}
		this.previewRenderChildren = [];
	}

	/**
	 * 顶部提示条：当前笔记内容已变化但索引可能过期。
	 *
	 * 点击“立即同步”会触发 `plugin.syncNotes([file.path])`：
	 * - 这会调用 embeddings API，真正更新索引
	 * - 同步完成后强制刷新 view（force=true）
	 */
	private renderDirtyBanner(parent: HTMLElement, file: TFile): void {
		const banner = parent.createEl("div", { cls: "sc-dirty-banner" });
		banner.createEl("span", {
			text: "⚠️ 当前笔记内容已更新，关联结果可能过时",
		});

		const action = banner.createEl("a", {
			text: "[立即同步]",
			cls: "sc-dirty-banner-action",
			href: "#",
		});

		action.addEventListener("click", (event) => {
			event.preventDefault();
			if (this.plugin.isSyncing) {
				return;
			}

			action.addClass("is-disabled");
			action.setAttr("aria-disabled", "true");
			void this.plugin
				.syncNotes([file.path], { noticeTitle: "正在同步当前笔记..." })
				.finally(() => {
					void this.refreshView(true);
				});
		});
	}

	/** 把相似度（通常是 [-1, 1]）格式化为百分比文本。 */
	private formatPercent(score: number, decimals: number = 1): string {
		if (!Number.isFinite(score)) {
			return "--%";
		}

		const percent = score * 100;
		const precision = Math.pow(10, decimals);
		const rounded = Math.round(percent * precision) / precision;
		if (Number.isInteger(rounded)) {
			return `${rounded.toFixed(0)}%`;
		}
		return `${rounded.toFixed(decimals)}%`;
	}

	/** 以固定小数位展示“原始分数”（便于 tooltip 中精确查看）。 */
	private formatRawScore(score: number, decimals: number = 3): string {
		if (!Number.isFinite(score)) {
			return "--";
		}
		return score.toFixed(decimals);
	}

	/**
	 * 渲染单条关联结果。
	 *
	 * 交互：
	 * - 点击标题/片段：打开目标笔记，并高亮 bestPassage 对应的行范围
	 * - tooltip：展示阈值、原始分数、聚合分数等调试信息
	 */
	private async renderResultItem(parent: Element, result: ConnectionResult): Promise<void> {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (event) => {
			event.preventDefault();
			const range = this.plugin.chunkStore.get(result.bestPassage.chunkId)?.range;
			void this.plugin.openNoteInMainLeaf(result.notePath, range);
		});

		const rawSimilarity = result.bestPassage.score;
		const threshold = this.plugin.settings.minSimilarityScore;
		const isWeak = rawSimilarity < threshold;
		const percentText = this.formatPercent(rawSimilarity);
		const rawSimilarityText = this.formatRawScore(rawSimilarity);

		const scoreEl = header.createEl("span", {
			text: `相关度 ${percentText}${isWeak ? " · 弱关联" : ""}`,
			cls: "sc-result-score",
		});

		const thresholdText = this.formatRawScore(threshold);
		scoreEl.setAttr(
			"title",
			[
				`相关度(最强片段): ${percentText}`,
				`原始分值: ${rawSimilarityText}`,
				`阈值: ${thresholdText} (${this.formatPercent(threshold)})`,
				`相关度(多段聚合): ${this.formatPercent(result.passageScore)} (原始分值: ${this.formatRawScore(result.passageScore)})`,
			].join(" | "),
		);

		const bestChunk = this.plugin.chunkStore.get(result.bestPassage.chunkId);
		const headingText = (bestChunk?.heading ?? result.bestPassage.heading).trim();
		const snippetText = (bestChunk?.text ?? result.bestPassage.text).trim();
		const range = bestChunk?.range;

		const snippetEl = item.createEl("div", { cls: "sc-result-passage sc-connection-snippet" });
		snippetEl.addEventListener("click", () => {
			void this.plugin.openNoteInMainLeaf(result.notePath, range);
		});
		snippetEl.setAttr(
			"title",
			`最强关联片段 · 相关度 ${percentText} · 原始分值: ${rawSimilarityText}${isWeak ? "（弱关联）" : ""}`,
		);

		if (headingText) {
			snippetEl.createEl("div", {
				text: headingText,
				cls: "sc-passage-heading",
			});
		}

		const previewEl = snippetEl.createEl("div", {
			cls: "sc-passage-text sc-passage-markdown markdown-rendered",
		});
		await this.renderMarkdownPreview(previewEl, snippetText, result.notePath);

		const pathEl = item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});
		pathEl.setAttr("title", result.notePath);
	}

	private async renderMarkdownPreview(
		container: HTMLElement,
		markdown: string,
		sourcePath: string,
	): Promise<void> {
		const text = markdown.trim();
		if (!text) {
			container.empty();
			container.setText("（空片段）");
			container.addClass("is-fallback");
			return;
		}

		const renderChild = new Component();
		this.addChild(renderChild);
		this.previewRenderChildren.push(renderChild);

		try {
			await MarkdownRenderer.render(this.app, text, container, sourcePath, renderChild);
		} catch {
			container.empty();
			container.setText(this.createFallbackPreviewText(text));
			container.addClass("is-fallback");
		}
	}

	private createFallbackPreviewText(markdown: string): string {
		const compact = markdown.replace(/\n{3,}/g, "\n\n").trim();
		const previewLimit = 320;
		return compact.length > previewLimit ? `${compact.slice(0, previewLimit)}...` : compact;
	}
}

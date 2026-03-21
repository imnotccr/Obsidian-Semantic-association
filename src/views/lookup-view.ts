/**
 * LookupView - 右侧栏“语义搜索”视图。
 *
 * 用户在输入框里输入自然语言 query 后：
 * 1) `executeSearch()` 调用 `LookupService.search(query, ...)`
 * 2) LookupService 会把 query embed 成向量，并在 chunk 向量里做相似度检索
 * 3) view 将结果渲染为列表（每条结果包含命中的最佳段落）
 *
 * 性能与一致性：
 * - 输入事件做 debounce（避免每敲一次键就请求 embeddings API）
 * - `searchRequestId` 解决竞态：新的搜索开始后，旧请求结果会被丢弃
 */
import { Component, ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import type SemanticConnectionsPlugin from "../main";
import type { LookupResult } from "../types";
import { debounce, type DebouncedFn } from "../utils/debounce";

/** Obsidian 用来识别 view 的 type 字符串（注册/激活视图时使用）。 */
export const VIEW_TYPE_LOOKUP = "semantic-connections-lookup";

/**
 * LookupView 实例对应一个 leaf（通常位于右侧栏）。
 *
 * 该 view 只负责 UI：
 * - 维护输入框与结果容器
 * - 触发查询（调用 LookupService）
 * - 渲染结果并处理点击跳转
 */
export class LookupView extends ItemView {
	/** 主插件实例：用于访问 settings、service/store，并记录日志。 */
	private plugin: SemanticConnectionsPlugin;
	/** 搜索输入框（onOpen 创建，onClose 置空）。 */
	private searchInput: HTMLInputElement | null = null;
	/** 结果容器（onOpen 创建，onClose 置空）。 */
	private resultsContainer: HTMLElement | null = null;
	/** 每次搜索递增，用于丢弃过期请求的结果（防竞态）。 */
	private searchRequestId = 0;
	/** 搜索结果预览渲染时创建的子组件，刷新时统一卸载避免泄漏。 */
	private previewRenderChildren: Component[] = [];
	/** 防抖后的 input handler：便于 onClose 时 cancel 定时器，避免 view 关闭后仍触发搜索。 */
	private debouncedSearch: DebouncedFn<(event: Event) => void> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SemanticConnectionsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_LOOKUP;
	}

	getDisplayText(): string {
		return "语义搜索";
	}

	getIcon(): string {
		return "search";
	}

	/**
	 * view 打开时触发：构建输入框与结果容器，并注册事件。
	 *
	 * 输入框事件：
	 * - input：debounce 后触发搜索
	 * - Enter：立即搜索
	 */
	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();

		const searchContainer = container.createEl("div", {
			cls: "sc-search-container",
		});
		this.searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "输入文本以执行语义搜索...",
			cls: "sc-search-input",
		});

		const debouncedSearch = debounce((_event: Event) => {
			void this.executeSearch();
		}, 300);
		this.debouncedSearch = debouncedSearch;
		this.searchInput.addEventListener("input", debouncedSearch);
		this.searchInput.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				void this.executeSearch();
			}
		});

		this.resultsContainer = container.createEl("div", {
			cls: "sc-results-container",
		});
	}

	/** view 关闭时触发：清理引用，并让未完成的搜索请求失效。 */
	async onClose(): Promise<void> {
		this.debouncedSearch?.cancel();
		this.debouncedSearch = null;
		this.clearPreviewRenderChildren();
		this.searchInput = null;
		this.resultsContainer = null;
		this.searchRequestId++;
	}

	/**
	 * 执行一次搜索：
	 * - 空 query：清空结果
	 * - 索引为空：提示用户先重建索引
	 * - 否则：调用 LookupService.search 并渲染结果
	 *
	 * 注意：该方法会调用 embeddings API（为 query 生成向量），因此必须做 debounce。
	 */
	private async executeSearch(): Promise<void> {
		const query = this.searchInput?.value?.trim() || "";
		if (!this.resultsContainer) {
			return;
		}

		if (!query) {
			this.searchRequestId++;
			this.resultsContainer.empty();
			return;
		}
		const requestId = ++this.searchRequestId;

		if (this.plugin.noteStore.size === 0) {
			this.renderMessage("索引为空，请先执行“重建索引”。");
			return;
		}

		this.renderMessage("正在搜索...");

		try {
			const results = await this.plugin.lookupService.search(
				query,
				this.plugin.settings.maxConnections,
				{ excludedFolders: this.plugin.settings.excludedFolders },
			);
			if (this.isStaleSearch(requestId, query)) {
				return;
			}

			if (results.length === 0) {
				this.renderMessage("未找到匹配结果。");
			} else {
				this.renderResults(results);
			}
		} catch (err) {
			if (this.isStaleSearch(requestId, query)) {
				return;
			}
			console.error("LookupView: search failed", err);
			await this.plugin.logRuntimeError("lookup-search", err, {
				errorType: "query",
				details: [
					`query_length=${query.length}`,
					`max_results=${this.plugin.settings.maxConnections}`,
				],
			});
			this.renderMessage("搜索失败，请检查控制台或日志。");
		}
	}

	/** 判断某次搜索请求是否已过期（用于防止异步结果乱序覆盖 UI）。 */
	private isStaleSearch(requestId: number, expectedQuery: string): boolean {
		if (requestId !== this.searchRequestId) {
			return true;
		}
		const currentQuery = this.searchInput?.value?.trim() || "";
		return currentQuery !== expectedQuery;
	}

	/** 渲染提示文案（空状态/加载中/未找到/失败等）。 */
	private renderMessage(message: string): void {
		if (!this.resultsContainer) {
			return;
		}
		this.clearPreviewRenderChildren();
		this.resultsContainer.empty();
		this.resultsContainer
			.createEl("div", { cls: "sc-placeholder" })
			.createEl("p", { text: message, cls: "sc-placeholder-text" });
	}

	/** 渲染搜索结果列表。 */
	private renderResults(results: LookupResult[]): void {
		if (!this.resultsContainer) {
			return;
		}
		this.clearPreviewRenderChildren();
		this.resultsContainer.empty();

		const list = this.resultsContainer.createEl("div", { cls: "sc-results-list" });
		for (const result of results) {
			void this.renderResultItem(list, result);
		}
	}

	private clearPreviewRenderChildren(): void {
		for (const child of this.previewRenderChildren) {
			child.unload();
		}
		this.previewRenderChildren = [];
	}

	/**
	 * 渲染单条搜索结果。
	 *
	 * 点击标题/段落会打开目标笔记，并高亮命中 chunk 对应的行范围（ChunkMeta.range）。
	 */
	private async renderResultItem(parent: Element, result: LookupResult): Promise<void> {
		const item = parent.createEl("div", { cls: "sc-result-item" });

		const header = item.createEl("div", { cls: "sc-result-header" });
		const titleEl = header.createEl("a", {
			text: result.title,
			cls: "sc-result-title",
		});
		titleEl.addEventListener("click", (event) => {
			event.preventDefault();
			const range = this.plugin.chunkStore.get(result.passage.chunkId)?.range;
			void this.plugin.openNoteInMainLeaf(result.notePath, range);
		});

		header.createEl("span", {
			text: `${(result.score * 100).toFixed(1)}%`,
			cls: "sc-result-score",
		});

		item.createEl("div", {
			text: result.notePath,
			cls: "sc-result-path",
		});

		if (result.passage) {
			const passageEl = item.createEl("div", { cls: "sc-result-passage" });
			passageEl.addEventListener("click", () => {
				const range = this.plugin.chunkStore.get(result.passage.chunkId)?.range;
				void this.plugin.openNoteInMainLeaf(result.notePath, range);
			});

			if (result.passage.heading) {
				passageEl.createEl("div", {
					text: result.passage.heading,
					cls: "sc-passage-heading",
				});
			}

			const previewEl = passageEl.createEl("div", {
				cls: "sc-passage-text sc-passage-markdown markdown-rendered",
			});
			await this.renderMarkdownPreview(previewEl, result.passage.text, result.notePath);
		}
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

/**
 * 插件入口文件
 *
 * 职责：
 * - 注册 views、commands、settings、events
 * - 初始化核心 services 并建立依赖关系
 * - 保持 onload() 轻量，不做大规模计算
 */

import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import {
	SemanticConnectionsSettings,
	DEFAULT_SETTINGS,
} from "./types";
import { ConnectionsView, VIEW_TYPE_CONNECTIONS } from "./views/connections-view";
import { LookupView, VIEW_TYPE_LOOKUP } from "./views/lookup-view";
import { SettingTab } from "./settings";
import { NoteStore } from "./storage/note-store";
import { ChunkStore } from "./storage/chunk-store";
import { VectorStore } from "./storage/vector-store";
import { Scanner } from "./indexing/scanner";
import { Chunker } from "./indexing/chunker";
import { ReindexService } from "./indexing/reindex-service";
import { ReindexQueue } from "./indexing/reindex-queue";
import { EmbeddingService } from "./embeddings/embedding-service";
import { ConnectionsService } from "./search/connections-service";
import { LookupService } from "./search/lookup-service";
import { ErrorLogger } from "./utils/error-logger";

export default class SemanticConnectionsPlugin extends Plugin {
	settings: SemanticConnectionsSettings = DEFAULT_SETTINGS;

	// 存储层
	noteStore!: NoteStore;
	chunkStore!: ChunkStore;
	vectorStore!: VectorStore;

	// 索引层
	private scanner!: Scanner;
	private chunker!: Chunker;
	private reindexService!: ReindexService;
	private reindexQueue!: ReindexQueue;

	// Embedding
	embeddingService!: EmbeddingService;

	// 搜索层
	connectionsService!: ConnectionsService;
	lookupService!: LookupService;

	// 错误日志
	errorLogger!: ErrorLogger;

	async onload(): Promise<void> {
		// 加载用户设置
		await this.loadSettings();

		// 初始化所有服务实例（轻量，不做计算）
		this.createServices();

		// 注册视图
		this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(VIEW_TYPE_LOOKUP, (leaf) => new LookupView(leaf, this));

		// 注册命令
		this.addCommand({
			id: "open-connections-view",
			name: "打开关联视图",
			callback: () => this.activateView(VIEW_TYPE_CONNECTIONS),
		});

		this.addCommand({
			id: "open-lookup-view",
			name: "打开语义搜索",
			callback: () => this.activateView(VIEW_TYPE_LOOKUP),
		});

		this.addCommand({
			id: "rebuild-index",
			name: "重建索引",
			callback: () => this.rebuildIndex(),
		});

		// 注册设置页
		this.addSettingTab(new SettingTab(this.app, this));

		// layout-ready 后执行初始索引和注册文件事件
		this.app.workspace.onLayoutReady(() => {
			this.onLayoutReady();
		});
	}

	onunload(): void {
		this.reindexQueue?.clear();
	}

	/** 加载设置 */
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	/** 保存设置 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * 创建所有服务实例
	 * 只做实例化和依赖注入，不执行任何 IO 或计算
	 */
	private createServices(): void {
		// 错误日志
		const logPath = `${this.app.vault.configDir}/plugins/semantic-connections/error-log.json`;
		this.errorLogger = new ErrorLogger(this.app.vault.adapter, logPath);

		// 存储层
		this.noteStore = new NoteStore();
		this.chunkStore = new ChunkStore();
		this.vectorStore = new VectorStore();

		// 索引层
		this.scanner = new Scanner(this.app.vault, this.app.metadataCache);
		this.chunker = new Chunker();
		this.embeddingService = new EmbeddingService(this.settings);

		this.reindexService = new ReindexService(
			this.app.vault,
			this.scanner,
			this.chunker,
			this.embeddingService,
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.errorLogger,
		);

		this.reindexQueue = new ReindexQueue();
		this.reindexQueue.setExecutor((task) => this.reindexService.processTask(task));

		// 搜索层
		this.connectionsService = new ConnectionsService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
		);

		this.lookupService = new LookupService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.embeddingService,
		);
	}

	/**
	 * layout-ready 后执行
	 * - 加载错误日志并执行月度清理
	 * - 注册文件变更事件
	 * - 如果从未索引过，触发全量索引
	 */
	private async onLayoutReady(): Promise<void> {
		// 加载错误日志 + 月度清理（30 天前的条目自动删除）
		await this.errorLogger.load();
		await this.errorLogger.cleanupIfNeeded();

		// 注册文件变更事件（增量索引）
		this.registerFileEvents();

		// 检查是否需要全量索引
		if (this.noteStore.size === 0) {
			await this.rebuildIndex();
		}

		console.log("Semantic Connections: ready");
	}

	/**
	 * 注册文件变更事件
	 * 通过 registerEvent 确保插件卸载时自动清理
	 */
	private registerFileEvents(): void {
		// 文件创建
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.reindexQueue.enqueue({ type: "create", path: file.path });
				}
			}),
		);

		// 文件修改
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.reindexQueue.enqueue({ type: "modify", path: file.path });
				}
			}),
		);

		// 文件删除
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.reindexQueue.enqueue({ type: "delete", path: file.path });
				}
			}),
		);

		// 文件重命名
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile && file.extension === "md") {
					this.reindexQueue.enqueue({ type: "rename", path: file.path, oldPath });
				}
			}),
		);
	}

	/**
	 * 激活指定类型的视图
	 * 如果已存在则聚焦，否则在右侧创建新叶子
	 */
	async activateView(viewType: string): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(viewType);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: viewType, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	/**
	 * 重建全量索引
	 *
	 * indexAll 返回 IndexSummary（total + failed），
	 * 即使部分文件失败也不会中断整个流程。
	 */
	private async rebuildIndex(): Promise<void> {
		const notice = new Notice("正在构建语义索引...", 0);

		try {
			const { total, failed } = await this.reindexService.indexAll(
				this.settings.excludedFolders,
				(done, total) => {
					notice.setMessage(`正在构建语义索引... (${done}/${total})`);
				},
			);

			if (failed > 0) {
				notice.setMessage(
					`索引完成：${this.noteStore.size} 篇笔记（${failed} 篇失败，详见错误日志）`,
				);
				setTimeout(() => notice.hide(), 5000);
			} else {
				notice.setMessage(`索引完成：${this.noteStore.size} 篇笔记`);
				setTimeout(() => notice.hide(), 3000);
			}
		} catch (err) {
			notice.setMessage("索引失败，请查看控制台");
			console.error("Semantic Connections: rebuild index failed", err);
			setTimeout(() => notice.hide(), 5000);
		}
	}
}

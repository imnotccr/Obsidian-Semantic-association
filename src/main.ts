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

	// Store 持久化
	private indexSnapshotPath: string = "";
	private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private indexSaveInProgress: Promise<void> | null = null;
	private indexSavePending = false;
	private indexSnapshotIncompatible = false;

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

		this.addCommand({
			id: "clean-local-model-cache",
			name: "清理旧本地模型缓存",
			callback: () => this.cleanOldLocalModelCache(),
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

		// 释放 Embedding Provider 持有的资源（如 LocalProvider 的 ONNX Session）
		if (this.embeddingService) {
			// switchProvider 内部会调用旧 provider 的 dispose
			// 这里直接获取当前 provider 并释放
			const provider = this.embeddingService as unknown as { provider?: { dispose?: () => Promise<void> } };
			if (provider.provider?.dispose) {
				void provider.provider.dispose();
			}
		}

		// 卸载时尽量把最近的增量索引变更落盘（不能 await，做 best-effort）
		this.cancelIndexSaveTimer();
		this.indexSavePending = true;
		void this.flushIndexSave();
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
		this.indexSnapshotPath = this.getPluginDataPath("index-store.json");

		// 错误日志
		const logPath = this.getPluginDataPath("error-log.json");
		this.errorLogger = new ErrorLogger(this.app.vault.adapter, logPath);

		// 存储层
		this.noteStore = new NoteStore();
		this.chunkStore = new ChunkStore();
		this.vectorStore = new VectorStore();

		// 索引层
		this.scanner = new Scanner(this.app.vault, this.app.metadataCache);
		this.chunker = new Chunker();
		this.embeddingService = new EmbeddingService(
			this.settings,
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);

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
		this.reindexQueue.setExecutor(async (task) => {
			try {
				await this.reindexService.processTask(task);
			} finally {
				// 增量索引是零散的：用 debounce 合并持久化写入，避免频繁写大 JSON
				this.scheduleIndexSave();
			}
		});

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

		// 尝试从磁盘恢复上次的索引（避免每次启动都全量重建）
		await this.loadIndexSnapshot();

		// 注册文件变更事件（增量索引）
		this.registerFileEvents();

		// 检查是否需要全量索引
		if (this.noteStore.size === 0) {
			// 索引快照存在但与当前 Embedding 配置不兼容时，不自动重建（避免意外触发远程 API 成本）
			if (this.indexSnapshotIncompatible) {
				new Notice("索引与当前 Embedding 配置不兼容，请手动执行「重建索引」。", 8000);
			} else if (
				this.settings.embeddingProvider === "remote" &&
				!this.settings.remoteApiKey
			) {
				new Notice("已选择远程 Embedding，但未配置 API Key。请先在设置中填写，然后执行「重建索引」。", 8000);
			} else {
				// mock 和 local 都可以直接开始索引
				// local 会在首次 embed 时触发模型下载
				await this.rebuildIndex();
			}
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
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isExcludedPath(file.path)) return;
				this.reindexQueue.enqueue({ type: "create", path: file.path });
			}),
		);

		// 文件修改
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.isExcludedPath(file.path)) return;
				this.reindexQueue.enqueue({ type: "modify", path: file.path });
			}),
		);

		// 文件删除
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				// delete 需要清理索引：即使该文件位于 excludedFolders，也可能残留旧索引
				this.reindexQueue.enqueue({ type: "delete", path: file.path });
			}),
		);

		// 文件重命名
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!this.settings.autoIndex) return;

				const newPath = file.path;
				const oldIsMd = this.isMarkdownPath(oldPath);
				const newIsMd = this.isMarkdownPath(newPath);

				// .md → 非 .md：移除旧索引
				if (oldIsMd && !newIsMd) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				// 非 .md → .md：等价于创建新索引（oldPath 不存在于索引中也无妨）
				if (!oldIsMd && newIsMd) {
					if (!this.isExcludedPath(newPath)) {
						this.reindexQueue.enqueue({ type: "create", path: newPath });
					}
					return;
				}

				// 都不是 .md：忽略
				if (!oldIsMd && !newIsMd) return;

				// .md → .md：如果新路径在 excludedFolders 中，则删除旧索引并跳过
				if (this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				// 从 excludedFolders 移出：老路径可能没索引，安全起见先删再建
				if (this.isExcludedPath(oldPath) && !this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					this.reindexQueue.enqueue({ type: "create", path: newPath });
					return;
				}

				this.reindexQueue.enqueue({ type: "rename", path: newPath, oldPath });
			}),
		);
	}

	/** 是否是 Markdown 文件路径（用于 rename oldPath/newPath 的字符串判断） */
	private isMarkdownPath(path: string): boolean {
		return path.toLowerCase().endsWith(".md");
	}

	/** 是否在排除文件夹内（逻辑与 Scanner.getMarkdownFiles 保持一致） */
	private isExcludedPath(path: string): boolean {
		return this.settings.excludedFolders.some((folder) =>
			path.startsWith(folder + "/") || path === folder
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
	/** 是否正在执行全量重建（防止设置页按钮重复触发） */
	isRebuilding = false;

	async rebuildIndex(): Promise<void> {
		if (this.isRebuilding) return;
		this.isRebuilding = true;
		// 进入重建流程说明用户已明确要生成新索引
		this.indexSnapshotIncompatible = false;

		const notice = new Notice("正在构建语义索引...", 0);

		try {
			// 清空旧错误日志：新一轮重建后日志应只包含本次结果
			await this.errorLogger.clear();

			// Full rebuild: clear existing index data first.
			this.noteStore.clear();
			this.chunkStore.clear();
			this.vectorStore.clear();

			// 设置模型下载进度监听（LocalProvider 首次加载时需要下载模型文件）
			this.embeddingService.setProgressListener((info) => {
				if (info.status === "progress" && info.file) {
					notice.setMessage(
						`正在下载模型: ${info.file} (${Math.round(info.progress ?? 0)}%)`,
					);
				} else if (info.status === "done") {
					notice.setMessage("模型加载完成，开始构建索引...");
				}
			});

			const { total, failed } = await this.reindexService.indexAll(
				this.settings.excludedFolders,
				(done, total) => {
					notice.setMessage(`正在构建语义索引... (${done}/${total})`);
				},
			);

			// 全量索引结束后落盘（即使部分文件失败，也保留已成功的结果）
			notice.setMessage("正在保存索引到磁盘...");
			await this.saveIndexSnapshot();

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
		} finally {
			this.embeddingService.setProgressListener(undefined);
			this.isRebuilding = false;
		}
	}

	/** 插件私有数据目录下的文件路径（相对于 vault 根目录） */
	private getPluginDataPath(filename: string): string {
		return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${filename}`;
	}

	private async loadIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath) return;

		try {
			if (!(await this.app.vault.adapter.exists(this.indexSnapshotPath))) return;

			const raw = await this.app.vault.adapter.read(this.indexSnapshotPath);
			const snapshot = JSON.parse(raw) as {
				version: number;
				savedAt?: number;
				embeddingProvider?: string;
				embeddingDimension?: number;
				remoteModel?: string;
				localModelId?: string;
				localDtype?: string;
				noteStore?: unknown;
				chunkStore?: unknown;
				vectorStore?: unknown;
			};

			if (!snapshot || typeof snapshot !== "object") return;
			if (snapshot.version !== 1) return;
			if (!snapshot.noteStore || !snapshot.chunkStore || !snapshot.vectorStore) return;

			// 快照与当前 embedding 配置不兼容时，拒绝加载，避免产生“随机召回”等异常结果
			const providerMismatch =
				snapshot.embeddingProvider &&
				snapshot.embeddingProvider !== this.settings.embeddingProvider;

			const modelMismatch =
				this.settings.embeddingProvider === "remote"
					? snapshot.remoteModel &&
						snapshot.remoteModel !== this.settings.remoteModel
					: this.settings.embeddingProvider === "local"
						? (snapshot.localModelId &&
								snapshot.localModelId !== this.settings.localModelId) ||
							(snapshot.localDtype &&
								snapshot.localDtype !== this.settings.localDtype)
						: false;

			const dimensionMismatch =
				this.settings.embeddingProvider !== "remote" &&
				typeof snapshot.embeddingDimension === "number" &&
				snapshot.embeddingDimension > 0 &&
				this.embeddingService.dimension > 0 &&
				snapshot.embeddingDimension !== this.embeddingService.dimension;

			if (providerMismatch || modelMismatch || dimensionMismatch) {
				this.indexSnapshotIncompatible = true;
				new Notice(
					"检测到索引快照与当前 Embedding 配置不兼容：已跳过加载。请手动执行「重建索引」。",
					8000,
				);
				return;
			}

			this.noteStore.load(snapshot.noteStore);
			this.chunkStore.load(snapshot.chunkStore);
			this.vectorStore.load(snapshot.vectorStore);

			console.log(
				`Semantic Connections: index loaded (notes=${this.noteStore.size}, chunks=${this.chunkStore.size}, vectors=${this.vectorStore.size})`,
			);
		} catch (err) {
			console.warn("Semantic Connections: failed to load index snapshot, starting fresh", err);
		}
	}

	private async saveIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath) return;

		const snapshot = {
			version: 1,
			savedAt: Date.now(),
			embeddingProvider: this.settings.embeddingProvider,
			embeddingDimension: this.embeddingService.dimension,
			remoteModel:
				this.settings.embeddingProvider === "remote"
					? this.settings.remoteModel
					: undefined,
			localModelId:
				this.settings.embeddingProvider === "local"
					? this.settings.localModelId
					: undefined,
			localDtype:
				this.settings.embeddingProvider === "local"
					? this.settings.localDtype
					: undefined,
			noteStore: this.noteStore.serialize(),
			chunkStore: this.chunkStore.serialize(),
			vectorStore: this.vectorStore.serialize(),
		};

		try {
			// 不做 pretty print：VectorStore 可能很大，避免额外的磁盘占用
			const serialized = JSON.stringify(snapshot);

			// 尽量用“临时文件 + rename”降低写入中断导致 JSON 损坏的概率
			const tmpPath = this.indexSnapshotPath + ".tmp";
			await this.app.vault.adapter.write(tmpPath, serialized);

			try {
				await this.app.vault.adapter.rename(tmpPath, this.indexSnapshotPath);
			} catch {
				// 部分 adapter 不允许覆盖已存在文件：先删除再 rename
				if (await this.app.vault.adapter.exists(this.indexSnapshotPath)) {
					await this.app.vault.adapter.remove(this.indexSnapshotPath);
				}
				await this.app.vault.adapter.rename(tmpPath, this.indexSnapshotPath);
			}
		} catch (err) {
			console.error("Semantic Connections: failed to save index snapshot", err);
		}
	}

	/**
	 * 清理旧的本地模型缓存（保留当前版本缓存目录）
	 */
	private async cleanOldLocalModelCache(): Promise<void> {
		const notice = new Notice("正在清理旧模型缓存...", 0);
		const adapter = this.app.vault.adapter;
		const modelsRoot = this.getPluginDataPath("models");
		const currentCache = this.embeddingService.getLocalModelCachePath();

		try {
			const exists = await adapter.exists(modelsRoot);
			if (!exists) {
				notice.setMessage("未发现模型缓存目录，无需清理。");
				setTimeout(() => notice.hide(), 2500);
				return;
			}

			const list = await adapter.list(modelsRoot);
			const foldersToDelete = list.folders.filter((p) => p !== currentCache);
			const filesToDelete = list.files.filter((p) => p !== currentCache);

			let removedFolders = 0;
			let removedFiles = 0;

			for (const file of filesToDelete) {
				try {
					await adapter.remove(file);
					removedFiles++;
				} catch (err) {
					console.warn("Semantic Connections: failed to remove cache file", file, err);
				}
			}

			for (const folder of foldersToDelete) {
				try {
					await adapter.rmdir(folder, true);
					removedFolders++;
				} catch (err) {
					console.warn("Semantic Connections: failed to remove cache folder", folder, err);
				}
			}

			if (removedFiles === 0 && removedFolders === 0) {
				notice.setMessage("未发现旧缓存，无需清理。");
			} else {
				notice.setMessage(`清理完成：移除 ${removedFolders} 个目录，${removedFiles} 个文件。`);
			}
			setTimeout(() => notice.hide(), 3000);
		} catch (err) {
			notice.setMessage("清理失败，请查看控制台。");
			console.error("Semantic Connections: clean cache failed", err);
			setTimeout(() => notice.hide(), 4000);
		}
	}

	private scheduleIndexSave(): void {
		this.indexSavePending = true;
		this.cancelIndexSaveTimer();

		// 写入可能很大：等增量索引稳定一段时间再落盘
		this.indexSaveTimer = setTimeout(() => {
			void this.flushIndexSave();
		}, 10_000);
	}

	private cancelIndexSaveTimer(): void {
		if (this.indexSaveTimer) {
			clearTimeout(this.indexSaveTimer);
			this.indexSaveTimer = null;
		}
	}

	private async flushIndexSave(): Promise<void> {
		if (!this.indexSavePending) return;

		if (this.indexSaveInProgress) {
			await this.indexSaveInProgress;
			return;
		}

		this.indexSaveInProgress = (async () => {
			while (this.indexSavePending) {
				this.indexSavePending = false;
				await this.saveIndexSnapshot();
			}
		})();

		try {
			await this.indexSaveInProgress;
		} finally {
			this.indexSaveInProgress = null;
		}
	}
}

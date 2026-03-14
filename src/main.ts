/**
 * Plugin entrypoint.
 */

/**
 * 插件主入口（Obsidian `Plugin`）。
 *
 * 这个文件负责把“索引构建 / 变动同步 / 语义搜索 / 关联视图”这些模块串成一个可运行的插件：
 * - 读取与持久化用户设置（Obsidian 的 `loadData()` / `saveData()`，对应插件目录下的 `data.json`）
 * - 初始化各类 Store（索引的内存态）与 Service（业务逻辑）
 * - 注册 View、命令、Ribbon 图标、Vault 文件事件
 * - 管理索引快照的加载/保存（`index-store.json` + `index-vectors.bin`）
 *
 * 运行时主流程（简化版，便于你从整体理解代码）：
 * 1) `onload()`：加载设置 -> 创建服务 -> 注册 view/command -> 等待 workspace layout ready
 * 2) `onLayoutReady()`：加载索引快照 -> 注册文件事件 -> 根据设置自动打开视图/提示是否需要重建
 * 3) 用户触发“重建索引”：扫描全部 Markdown -> 切分为 chunk -> 生成 embedding 向量 -> 写入 store -> 落盘快照
 * 4) `ConnectionsView` / `LookupView`：通过 `ConnectionsService` / `LookupService` 查询向量相似度并展示结果
 *
 * 设计取舍：
 * - 本插件默认不会在后台“悄悄”调用远程 embeddings API。
 *   `autoIndex` 只会把笔记标记为“可能过期”，需要你手动执行“同步变动笔记”或“重建索引”才会真正请求 API，
 *   这样可以避免无意的 token / 费用消耗。
 */

import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	type IndexErrorEntry,
	type IndexStorageSummary,
	type RebuildIndexProgress,
	type RuntimeLogCategory,
	type RuntimeLogEntry,
	type RuntimeLogLevel,
	type SemanticConnectionsSettings,
} from "./types";
import { EmbeddingService } from "./embeddings/embedding-service";
import { normalizeRemoteBaseUrl } from "./embeddings/remote-provider";
import { Chunker } from "./indexing/chunker";
import { FailedTaskManager } from "./indexing/failed-task-manager";
import { ReindexQueue } from "./indexing/reindex-queue";
import { ReindexService } from "./indexing/reindex-service";
import { Scanner } from "./indexing/scanner";
import { ConnectionsService } from "./search/connections-service";
import { LookupService } from "./search/lookup-service";
import { SettingTab } from "./settings";
import { ChunkStore } from "./storage/chunk-store";
import { NoteStore } from "./storage/note-store";
import { VectorStore } from "./storage/vector-store";
import { mergeErrorDetails, normalizeErrorDiagnostic } from "./utils/error-utils";
import { ErrorLogger } from "./utils/error-logger";
import { hashContent } from "./utils/hash";
import { RuntimeLogger } from "./utils/runtime-logger";
import { ConnectionsView, VIEW_TYPE_CONNECTIONS } from "./views/connections-view";
import { LookupView, VIEW_TYPE_LOOKUP } from "./views/lookup-view";
import { SyncChangedNotesModal } from "./views/sync-changed-notes-modal";

/**
 * 记录到 `error-log.json` 时的可选补充字段。
 *
 * 这些字段会被 `logRuntimeError()` 合并进 `IndexErrorEntry`，让错误日志在排查时更“有上下文”：
 * - errorType：错误大类（embedding / storage / configuration ...）
 * - filePath：当前正在处理的笔记路径（或虚拟路径，例如 `__settings__/...`）
 * - details：额外细节（例如 HTTP 状态码、模型名、批大小等）
 * - provider/stage：帮助你把错误定位到某一个 provider 与某一个处理阶段
 */
type RuntimeErrorLogOptions = {
	errorType?: IndexErrorEntry["errorType"];
	filePath?: string;
	details?: string[];
	provider?: string;
	stage?: string;
};

/**
 * 记录到 `runtime-log.json` 的事件补充字段。
 *
 * runtime log 的定位是“时间线”：
 * - 发生了什么（event/message）
 * - 发生在插件哪个环节（category）
 * - 严重程度（level）
 */
type RuntimeEventLogOptions = {
	level?: RuntimeLogLevel;
	category?: RuntimeLogCategory;
	details?: string[];
	provider?: string;
};

/**
 * 重建索引时的可选参数。
 *
 * `onProgress` 会把进度事件回传给 Settings UI 或 View，以便显示进度条/状态文案。
 */
type RebuildIndexOptions = {
	onProgress?: (progress: RebuildIndexProgress) => void;
};

/**
 * 索引快照（持久化到磁盘）的结构。
 *
 * 这个快照是“可恢复”的：下次启动插件时，会从磁盘读取它并恢复到 NoteStore/ChunkStore/VectorStore。
 *
 * 为什么快照要带上 provider/model/dimension/strategy？
 * - embedding 维度变了（例如切换模型），旧向量就不能拿来做相似度比较了
 * - chunk 切分策略变了，chunkId、range 等可能完全不同
 * - note 向量聚合策略变了（例如从 mean -> max），排序分数也会变
 * 因此需要做“兼容性校验”：不兼容就跳过加载，让用户手动重建索引。
 */
type PersistedIndexSnapshot = {
	version: number;
	savedAt?: number;
	lastFullRebuildAt?: number;
	embeddingProvider?: string;
	embeddingDimension?: number;
	remoteBaseUrl?: string;
	remoteModel?: string;
	chunkingStrategy?: string;
	noteVectorStrategy?: string;
	vectorBinaryPath?: string;
	noteStore?: unknown;
	chunkStore?: unknown;
	vectorStore?: unknown;
};

/**
 * 快照版本号：用于做向后兼容与演进。
 * - 版本 1：全 JSON
 * - 版本 2+：向量部分改用二进制（`index-vectors.bin`），以减少体积、提升读取速度
 */
const CURRENT_INDEX_SNAPSHOT_VERSION = 3;

/**
 * 当前使用的切分策略标识。
 *
 * 注意：这里是“策略名”，真正的切分逻辑在 `Chunker` 里。
 * 这个名字会写入快照，用来判断旧快照能不能继续用。
 */
const CURRENT_CHUNKING_STRATEGY = "paragraph-first-v3-overlap20";

/**
 * 当前使用的“笔记向量”策略标识。
 *
 * 含义：一个 note 会被切成多个 chunk，每个 chunk 有自己的 embedding 向量；
 * note 向量则是把这些 chunk 向量聚合（例如取均值）得到的“整篇笔记语义向量”。
 */
const CURRENT_NOTE_VECTOR_STRATEGY = "chunk-mean-v1";

/** 启动提示：距离上次全量重建超过 N 天就提醒一次（不会自动重建）。 */
const FULL_REBUILD_REMINDER_DAYS = 7;
/** 1 天的毫秒数，用于时间差计算。 */
const MS_PER_DAY = 86_400_000;

/**
 * 插件主类：Obsidian 会实例化它，并在生命周期中调用 `onload()` / `onunload()`。
 *
 * 你可以把它理解为“应用层容器（composition root）”：
 * - 负责创建/持有所有 store 与 service
 * - 把 UI（views、settings tab、commands）与底层能力（indexing、embedding、storage）连接起来
 * - 维护少量全局状态：是否正在重建/同步、索引版本号、索引快照读写的节流等
 */
export default class SemanticConnectionsPlugin extends Plugin {
	/** 插件设置（持久化在 Obsidian 的 `data.json`） */
	settings: SemanticConnectionsSettings = DEFAULT_SETTINGS;

	// ---- Stores：索引的内存态（可序列化成快照） ----
	noteStore!: NoteStore;
	chunkStore!: ChunkStore;
	vectorStore!: VectorStore;

	// ---- Services：业务逻辑（读写 store、请求 embeddings） ----
	embeddingService!: EmbeddingService;
	connectionsService!: ConnectionsService;
	lookupService!: LookupService;

	// ---- Loggers / recovery：辅助诊断与可恢复性 ----
	errorLogger!: ErrorLogger;
	runtimeLogger!: RuntimeLogger;
	failedTaskManager!: FailedTaskManager;

	// ---- Indexing pipeline helpers ----
	private scanner!: Scanner;
	private chunker!: Chunker;
	private reindexService!: ReindexService;
	private reindexQueue!: ReindexQueue;

	// ---- Snapshot persistence state ----
	private indexSnapshotPath = "";
	private indexVectorSnapshotPath = "";

	/**
	 * 为了减少磁盘 IO，本插件对“索引快照保存”做了节流：
	 * - `scheduleIndexSave()` 会设置一个 10s 的 timer，把多次变更合并成一次落盘
	 * - `flushIndexSave()` 用一个 promise 锁保证不会并发写文件
	 */
	private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private indexSaveInProgress: Promise<void> | null = null;
	private indexSavePending = false;

	/**
	 * 当检测到快照与当前配置不兼容时置为 true，用于启动提示与避免错误加载。
	 * 典型原因：切换 embedding provider / model、向量维度变化、切分策略变化等。
	 */
	private indexSnapshotIncompatible = false;

	/** 防止重入：重建索引是一个长任务，UI/命令需要根据它禁用按钮等 */
	isRebuilding = false;
	/** 防止重入：同步变动笔记时同样需要串行，避免与重建并发 */
	isSyncing = false;

	/** 索引版本号（内存态）。每次“索引数据发生变化”就递增一次，用于通知 UI 刷新。 */
	private indexVersionValue = 0;

	/**
	 * “变动监听”会很频繁（尤其是编辑时的连续 modify 事件）。
	 * 这里用 per-path 的 timer 做 debounce，避免反复读文件/计算 hash。
	 */
	private dirtyCheckTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	/**
	 * 索引版本号 getter（只读）。
	 *
	 * ConnectionsView 会用它判断“索引是否更新”，从而刷新关联结果。
	 */
	get indexVersion(): number {
		return this.indexVersionValue;
	}

	async onload(): Promise<void> {
		// onload 阶段尽量做“轻量初始化”：
		// - 加载设置
		// - 创建服务（但不做大规模 IO）
		// - 注册 view/command/settings tab
		// 大规模 IO（读取快照、扫描 vault）放到 layout ready 后执行。
		await this.loadSettings();
		this.createServices();
		await this.failedTaskManager.load();
		this.registerGlobalErrorHandlers();

		// 注册右侧栏视图：关联视图 + 语义搜索视图
		this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(VIEW_TYPE_LOOKUP, (leaf) => new LookupView(leaf, this));

		// Ribbon 图标：提供一个最直观的入口打开关联视图
		this.addRibbonIcon("link", "Show Connections View", () => {
			void this.activateView(VIEW_TYPE_CONNECTIONS);
		});

		// Command Palette 命令：打开视图、重建索引、同步变动笔记等
		this.addCommand({
			id: "open-connections-view",
			name: "打开关联视图",
			callback: () => this.activateView(VIEW_TYPE_CONNECTIONS),
		});

		this.addCommand({
			id: "show-connections-view",
			name: "Show Connections View",
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
			id: "sync-changed-notes",
			name: "Sync Changed Notes（同步变动笔记）",
			callback: () => {
				void this.syncChangedNotes();
			},
		});

		this.addCommand({
			id: "show-index-storage-summary",
			name: "查看索引存储统计",
			callback: () => {
				void this.showIndexStorageSummary();
			},
		});

		this.addSettingTab(new SettingTab(this.app, this));

		// 等 Obsidian 的 workspace 布局完成后，再做涉及 vault/adapter 的 IO 操作。
		// 这样能避免“插件启动太早，workspace 尚未就绪”导致的一些边界问题。
		this.app.workspace.onLayoutReady(() => {
			void this.onLayoutReady().catch((error) => {
				console.error("Semantic Connections: onLayoutReady failed", error);
				void this.logRuntimeError("on-layout-ready", error, {
					stage: "on-layout-ready",
				});
			});
		});
	}

	onunload(): void {
		// 卸载/禁用插件时：尽量把未落盘的数据保存掉，并清理后台任务。
		this.reindexQueue?.clear();
		this.clearDirtyCheckTimers();
		this.cancelIndexSaveTimer();
		this.indexSavePending = true;
		void this.flushIndexSave();
		void this.embeddingService?.disposeCurrentProvider().catch(() => undefined);
		void this.runtimeLogger?.save();
		void this.errorLogger?.save();
		void this.failedTaskManager?.save();
	}

	/**
	 * 从 Obsidian 的 `data.json` 读取设置，并做：
	 * - 旧字段迁移（例如历史版本的 `minPassageScore`）
	 * - 输入值归一化与兜底（防止用户手动改坏 JSON 导致插件崩溃）
	 */
	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<SemanticConnectionsSettings> & Record<string, unknown>)
			| null;
		const loaded = raw ?? {};
		const legacyMinPassageScore = loaded["minPassageScore"];
		const minSimilarityScoreRaw =
			typeof loaded.minSimilarityScore === "number" && Number.isFinite(loaded.minSimilarityScore)
				? loaded.minSimilarityScore
				: typeof legacyMinPassageScore === "number" && Number.isFinite(legacyMinPassageScore)
					? legacyMinPassageScore
					: DEFAULT_SETTINGS.minSimilarityScore;

		this.settings = {
			maxConnections:
				typeof loaded.maxConnections === "number"
					? loaded.maxConnections
					: DEFAULT_SETTINGS.maxConnections,
			minSimilarityScore: Math.max(0, Math.min(1, minSimilarityScoreRaw)),
			maxPassagesPerNote:
				typeof loaded.maxPassagesPerNote === "number" &&
				Number.isInteger(loaded.maxPassagesPerNote) &&
				loaded.maxPassagesPerNote >= 0
					? loaded.maxPassagesPerNote
					: DEFAULT_SETTINGS.maxPassagesPerNote,
			excludedFolders: Array.isArray(loaded.excludedFolders)
				? loaded.excludedFolders.filter((folder): folder is string => typeof folder === "string")
				: DEFAULT_SETTINGS.excludedFolders,
			embeddingProvider: DEFAULT_SETTINGS.embeddingProvider,
			autoIndex:
				typeof loaded.autoIndex === "boolean"
					? loaded.autoIndex
					: DEFAULT_SETTINGS.autoIndex,
			autoOpenConnectionsView:
				typeof loaded.autoOpenConnectionsView === "boolean"
					? loaded.autoOpenConnectionsView
					: DEFAULT_SETTINGS.autoOpenConnectionsView,
			lastFullRebuildAt:
				typeof loaded.lastFullRebuildAt === "number" &&
				Number.isFinite(loaded.lastFullRebuildAt) &&
				loaded.lastFullRebuildAt > 0
					? loaded.lastFullRebuildAt
					: DEFAULT_SETTINGS.lastFullRebuildAt,
			remoteBaseUrl:
				typeof loaded.remoteBaseUrl === "string"
					? loaded.remoteBaseUrl.trim()
					: DEFAULT_SETTINGS.remoteBaseUrl,
			remoteApiKey:
				typeof loaded.remoteApiKey === "string"
					? loaded.remoteApiKey.trim()
					: DEFAULT_SETTINGS.remoteApiKey,
			remoteModel:
				typeof loaded.remoteModel === "string" && loaded.remoteModel.trim().length > 0
					? loaded.remoteModel.trim()
					: DEFAULT_SETTINGS.remoteModel,
			remoteTimeoutMs:
				typeof loaded.remoteTimeoutMs === "number" &&
				Number.isInteger(loaded.remoteTimeoutMs) &&
				loaded.remoteTimeoutMs > 0
					? loaded.remoteTimeoutMs
					: DEFAULT_SETTINGS.remoteTimeoutMs,
			remoteBatchSize:
				typeof loaded.remoteBatchSize === "number" &&
				Number.isInteger(loaded.remoteBatchSize) &&
				loaded.remoteBatchSize > 0
					? loaded.remoteBatchSize
					: DEFAULT_SETTINGS.remoteBatchSize,
		};
	}

	async saveSettings(context: string = "settings"): Promise<void> {
		try {
			await this.saveData(this.settings);
		} catch (error) {
			console.error("Semantic Connections: failed to save settings", context, error);
			if (this.errorLogger) {
				await this.logRuntimeError("save-settings", error, {
					stage: "settings-save",
					errorType: "configuration",
					filePath: `__settings__/${context}`,
					details: [`context=${context}`],
				});
			}
			throw error;
		}
	}

	/**
	 * “索引版本号”用于通知 UI：索引内容发生变化，需要刷新结果。
	 *
	 * 这是一个很常见的前端模式：用一个递增的 version 当作“变更信号”，
	 * 避免在各个 store 内部实现复杂的订阅/事件总线。
	 */
	private bumpIndexVersion(reason: string): void {
		this.indexVersionValue++;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONNECTIONS);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof ConnectionsView) {
				view.onIndexVersionChanged(this.indexVersionValue, reason);
			}
		}
	}

	/** 清空当前内存中的索引数据（不会自动重建，需要用户手动触发）。 */
	clearIndexData(): void {
		this.noteStore.clear();
		this.chunkStore.clear();
		this.vectorStore.clear();
		this.bumpIndexVersion("index-cleared");
	}

	/**
	 * 统一的运行时错误记录入口。
	 *
	 * 与 `console.error` 的区别：
	 * - console 只在当前 session 可见
	 * - error log 会持久化到 `error-log.json`，方便用户事后排查与反馈
	 */
	async logRuntimeError(
		operation: string,
		error: unknown,
		options: RuntimeErrorLogOptions = {},
	): Promise<void> {
		const diagnostic = normalizeErrorDiagnostic(error);
		const provider = options.provider ?? this.settings.embeddingProvider;
		const details = mergeErrorDetails(options.details, diagnostic.details, [
			`operation=${operation}`,
			`provider=${provider}`,
		]);

		await this.errorLogger.logAndSave({
			filePath: options.filePath ?? `__plugin__/${operation}`,
			errorType: options.errorType ?? "runtime",
			message: diagnostic.message,
			provider,
			errorName: diagnostic.name,
			errorCode: diagnostic.code,
			stage: diagnostic.stage ?? options.stage,
			stack: diagnostic.stack,
			details,
		});
	}

	/**
	 * 运行时事件日志（通常是 info/warn），用于记录“发生了什么事情”。
	 *
	 * 例子：启动完成、加载快照成功、用户点击了测试连接、索引重建完成等。
	 */
	async logRuntimeEvent(
		event: string,
		message: string,
		options: RuntimeEventLogOptions = {},
	): Promise<void> {
		await this.runtimeLogger.logAndSave({
			event,
			level: options.level ?? "info",
			category: options.category ?? "embedding",
			message,
			provider: options.provider ?? this.settings.embeddingProvider,
			details: options.details,
		});
	}

	/** 获取最近的运行日志（用于 UI 展示/调试）。 */
	getRecentRuntimeLogs(count: number = 50): RuntimeLogEntry[] {
		return this.runtimeLogger.getRecent(count);
	}

	async clearRuntimeLogs(): Promise<void> {
		try {
			await this.runtimeLogger.clear();
			if (this.runtimeLogger.isDirty) {
				throw new Error("Runtime log clear was not persisted.");
			}
		} catch (error) {
			await this.logRuntimeError("clear-runtime-logs", error, {
				stage: "runtime-log-clear",
				errorType: "storage",
				filePath: "__runtime__/runtime-log",
			});
			throw error;
		}
	}

	async clearErrorLogs(): Promise<void> {
		try {
			await this.errorLogger.clear();
			if (this.errorLogger.isDirty) {
				throw new Error("Error log clear was not persisted.");
			}
		} catch (error) {
			await this.logRuntimeEvent("error-log-clear-failed", "清空错误日志失败。", {
				level: "warn",
				category: "storage",
				details: [
					"log=error",
					error instanceof Error ? `cause=${error.message}` : `cause=${String(error)}`,
				],
			});
			throw error;
		}
	}

	/**
	 * 全局错误捕获：
	 * - `window.error`：同步异常（或浏览器抛出的资源错误）
	 * - `unhandledrejection`：未捕获的 Promise rejection
	 *
	 * 这里会做一次“是否与本插件相关”的过滤，避免把其它插件/Obsidian 自身的错误也记进来。
	 */
	private registerGlobalErrorHandlers(): void {
		if (typeof window === "undefined") {
			return;
		}

		this.registerDomEvent(window, "error", (event: ErrorEvent) => {
			if (!this.isPluginRelatedRuntimeValue(event.error ?? event.message ?? event.filename)) {
				return;
			}

			void this.logRuntimeError("window-error", event.error ?? event.message, {
				stage: "window-error",
				details: [
					event.filename ? `filename=${event.filename}` : undefined,
					typeof event.lineno === "number" ? `line=${event.lineno}` : undefined,
					typeof event.colno === "number" ? `column=${event.colno}` : undefined,
				].filter((item): item is string => Boolean(item)),
			});
		});

		this.registerDomEvent(window, "unhandledrejection", (event: PromiseRejectionEvent) => {
			if (!this.isPluginRelatedRuntimeValue(event.reason)) {
				return;
			}

			void this.logRuntimeError("unhandled-rejection", event.reason, {
				stage: "unhandled-rejection",
			});
		});
	}

	/**
	 * 粗略判断一个错误/字符串是否可能来自本插件。
	 *
	 * Obsidian 是多插件环境：全局错误事件里可能包含别的插件的异常。
	 * 这里用关键词做 best-effort 过滤，减少噪音日志。
	 */
	private isPluginRelatedRuntimeValue(value: unknown): boolean {
		const text =
			value instanceof Error
				? `${value.name} ${value.message} ${value.stack ?? ""}`
				: typeof value === "string"
					? value
					: value && typeof value === "object"
						? JSON.stringify(value)
						: String(value ?? "");
		const normalized = text.toLowerCase();

		return [
			"semantic connections",
			"semantic-connections",
			"embeddingservice",
			"remoteprovider",
			"reindexservice",
			"lookupview",
			"connectionsview",
			this.manifest.id.toLowerCase(),
		].some((token) => normalized.includes(token));
	}

	/**
	 * 创建并连接插件的各个组件（store/service/logger/queue）。
	 *
	 * 注意：这里的创建不应触发大量 IO；真正的“加载快照 / 扫描 vault”
	 * 会在 `onLayoutReady()` 中进行。
	 */
	private createServices(): void {
		// 索引快照文件路径（保存于 {vault}/.obsidian/plugins/<id>/...）
		this.indexSnapshotPath = this.getPluginDataPath("index-store.json");
		this.indexVectorSnapshotPath = this.getPluginDataPath("index-vectors.bin");

		// 持久化日志：错误日志 / 运行日志 / 失败任务（可重试）
		const logPath = this.getPluginDataPath("error-log.json");
		this.errorLogger = new ErrorLogger(this.app.vault.adapter, logPath);
		const runtimeLogPath = this.getPluginDataPath("runtime-log.json");
		this.runtimeLogger = new RuntimeLogger(this.app.vault.adapter, runtimeLogPath);
		const failedTaskPath = this.getPluginDataPath("failed-tasks.json");
		this.failedTaskManager = new FailedTaskManager(this.app.vault.adapter, failedTaskPath);

		this.noteStore = new NoteStore();
		this.chunkStore = new ChunkStore();
		this.vectorStore = new VectorStore();

		// Scanner：枚举 vault 中的 Markdown，并提供读取能力
		this.scanner = new Scanner(this.app.vault, this.app.metadataCache);
		// Chunker：把一篇笔记切成多个“语义片段”
		this.chunker = new Chunker();
		// EmbeddingService：负责根据 settings 选择 provider，并把文本转成向量
		this.embeddingService = new EmbeddingService(this.settings);

		// ReindexService：索引流水线的核心编排（scan -> chunk -> embed -> store）
		this.reindexService = new ReindexService(
			this.app.vault,
			this.scanner,
			this.chunker,
			this.embeddingService,
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.errorLogger,
			this.failedTaskManager,
		);

		// ReindexQueue：串行执行增量索引任务，并在每个任务完成后节流保存快照
		this.reindexQueue = new ReindexQueue();
		this.reindexQueue.setExecutor(async (task) => {
			try {
				await this.reindexService.processTask(task);
			} finally {
				this.scheduleIndexSave();
			}
		});

		// ConnectionsService：给“关联视图”用的查询服务（根据当前笔记找相似笔记/段落）
		this.connectionsService = new ConnectionsService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
		);

		// LookupService：给“语义搜索”用的查询服务（把 query embed 后做向量检索）
		this.lookupService = new LookupService(
			this.noteStore,
			this.chunkStore,
			this.vectorStore,
			this.embeddingService,
		);
	}

	/**
	 * workspace layout ready 后的启动序列：
	 * - 载入并清理日志文件
	 * - 尝试从磁盘恢复索引快照
	 * - 注册 vault 文件事件（可选的“变动标记”）
	 * - 根据设置自动打开视图、提示是否需要手动重建索引
	 */
	private async onLayoutReady(): Promise<void> {
		await this.errorLogger.load();
		await this.errorLogger.cleanupIfNeeded();
		await this.runtimeLogger.load();
		await this.runtimeLogger.cleanupIfNeeded();
		await this.logRuntimeEvent("startup-sequence-started", "插件进入布局就绪阶段。", {
			category: "lifecycle",
		});

		await this.loadIndexSnapshot();
		this.registerFileEvents();

		if (this.settings.autoOpenConnectionsView) {
			// Auto-open should not steal focus from the editor.
			await this.ensureConnectionsViewOpen({ active: false, reveal: true });
			await this.logRuntimeEvent("connections-view-auto-opened", "关联视图已自动打开。", {
				category: "lifecycle",
			});
		}

		if (this.noteStore.size === 0) {
			if (this.indexSnapshotIncompatible) {
				new Notice("检测到当前嵌入、切分或笔记向量策略与已有索引快照不兼容，已跳过加载。请手动重建索引。", 8000);
			} else if (
				this.settings.embeddingProvider === "remote" &&
				(!this.settings.remoteBaseUrl.trim() || !this.settings.remoteApiKey.trim())
			) {
				new Notice(
					"已启用远程嵌入，但 API 基础 URL 或 API 密钥缺失。请补全配置后手动重建索引。",
					8000,
				);
				await this.logRuntimeEvent(
					"startup-index-rebuild-blocked",
					"远程嵌入配置不完整，无法重建索引（需用户补全配置后手动重建）。",
					{
						category: "lifecycle",
						provider: "remote",
					},
				);
			} else {
				new Notice("未检测到可用索引快照。如需更新索引，请手动执行“重建索引”。", 8000);
				await this.logRuntimeEvent(
					"startup-auto-rebuild-disabled",
					"启动时未自动重建索引（需手动触发）。",
					{
						category: "lifecycle",
					},
				);
			}
		} else {
			await this.maybeNotifyWeeklyRebuildReminder();
		}

		await this.logRuntimeEvent("plugin-ready", "插件启动完成。", {
			category: "lifecycle",
		});
		console.log("Semantic Connections: ready");
	}

	/**
	 * 注册 vault 文件事件，用于在用户编辑笔记时做“增量索引”的输入准备。
	 *
	 * 重要：当 `autoIndex=true` 时，本插件仍然不会自动请求 embeddings API；
	 * 它只会通过 hash 比较把笔记标记为 dirty/outdated（需要用户手动同步）。
	 */
	private registerFileEvents(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) {
					return;
				}
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				if (this.isExcludedPath(file.path)) {
					return;
				}
				this.scheduleDirtyCheck(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) {
					return;
				}
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				if (this.isExcludedPath(file.path)) {
					return;
				}
				this.scheduleDirtyCheck(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (!this.settings.autoIndex) {
					return;
				}
				if (!(file instanceof TFile) || file.extension !== "md") {
					return;
				}
				this.reindexQueue.enqueue({ type: "delete", path: file.path });
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!this.settings.autoIndex) {
					return;
				}

				const newPath = file.path;
				const oldIsMd = this.isMarkdownPath(oldPath);
				const newIsMd = this.isMarkdownPath(newPath);

				if (oldIsMd && !newIsMd) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				if (!oldIsMd && newIsMd) {
					// 新增 Markdown 文件不自动索引；由用户手动执行“同步变动笔记”。
					return;
				}

				if (!oldIsMd && !newIsMd) {
					return;
				}

				if (this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					return;
				}

				if (this.isExcludedPath(oldPath) && !this.isExcludedPath(newPath)) {
					this.reindexQueue.enqueue({ type: "delete", path: oldPath });
					// 迁出排除目录的笔记不自动索引；由用户手动执行“同步变动笔记”。
					return;
				}

				this.reindexQueue.enqueue({ type: "rename", path: newPath, oldPath });
			}),
		);
	}

	private isMarkdownPath(path: string): boolean {
		return path.toLowerCase().endsWith(".md");
	}

	/** 判断一个路径是否属于“排除目录”（例如 templates/）。 */
	private isExcludedPath(path: string): boolean {
		return this.settings.excludedFolders.some(
			(folder) => path.startsWith(folder + "/") || path === folder,
		);
	}

	/** 清理所有 debounce timer（插件卸载/禁用时调用）。 */
	private clearDirtyCheckTimers(): void {
		for (const timer of this.dirtyCheckTimers.values()) {
			clearTimeout(timer);
		}
		this.dirtyCheckTimers.clear();
	}

	/**
	 * 对单个文件路径做 debounce：
	 * - create/modify 事件可能在短时间内连发
	 * - 直接每次都读文件/算 hash 会浪费性能
	 */
	private scheduleDirtyCheck(path: string): void {
		const existing = this.dirtyCheckTimers.get(path);
		if (existing) {
			clearTimeout(existing);
		}

		const timer = setTimeout(() => {
			this.dirtyCheckTimers.delete(path);
			void this.reconcileDirtyFlagForPath(path);
		}, 400);
		this.dirtyCheckTimers.set(path, timer);
	}

	/**
	 * 读取文件内容并计算 hash，判断它是否“相对于索引”已经过期。
	 *
	 * 只有当 note 已经存在于 `noteStore`（即曾被索引过）时，我们才会标记 dirty/outdated；
	 * 新文件的索引由用户手动同步触发（避免后台意外调用 embeddings API）。
	 */
	private async reconcileDirtyFlagForPath(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		if (this.isExcludedPath(file.path)) {
			return;
		}

		const existing = this.noteStore.get(file.path);
		if (!existing) {
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const hash = hashContent(content);
		const isOutdated = existing.hash !== hash;
		const isMarkedDirty = existing.dirty || existing.outdated;

		if (isOutdated && !isMarkedDirty) {
			this.noteStore.set({ ...existing, dirty: true, outdated: true });
			this.scheduleIndexSave();
			return;
		}

		if (!isOutdated && isMarkedDirty) {
			this.noteStore.set({ ...existing, dirty: undefined, outdated: undefined });
			this.scheduleIndexSave();
		}
	}

	/**
	 * 通用的“确保某个 view 在右侧栏打开”的兼容封装。
	 *
	 * Obsidian 不同版本的 API 有差异：较新的版本提供 `ensureSideLeaf`，
	 * 老版本则只能用 `getRightLeaf()` + `setViewState()` 组合实现。
	 */
	private async ensureViewOpen(viewType: string, options?: { reveal?: boolean }): Promise<void> {
		const { workspace } = this.app;
		const reveal = options?.reveal ?? false;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(viewType);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			const ensureSideLeaf = (workspace as unknown as { ensureSideLeaf?: unknown }).ensureSideLeaf;
			if (typeof ensureSideLeaf === "function") {
				leaf = await (workspace as any).ensureSideLeaf(viewType, "right", {
					active: true,
					reveal,
					split: false,
				});
			} else {
				leaf = workspace.getRightLeaf(true);
				if (leaf) {
					await leaf.setViewState({ type: viewType, active: true });
				}
			}
		}

		if (leaf && reveal) {
			workspace.revealLeaf(leaf);
		}
	}

	/**
	 * ConnectionsView 是本插件的核心视图：我们希望它始终位于右侧栏，并且只保留一个实例。
	 *
	 * 另外，自动打开时不会抢走编辑器焦点（避免打断写作体验）。
	 */
	private async ensureConnectionsViewOpen(options?: { reveal?: boolean; active?: boolean }): Promise<void> {
		const { workspace } = this.app;
		const reveal = options?.reveal ?? false;
		const active = options?.active ?? false;
		const editorLeaf = workspace.getMostRecentLeaf(workspace.rootSplit);

		// Ensure the right sidebar is visible when we want to reveal the view.
		if (reveal) {
			try {
				workspace.rightSplit.expand();
			} catch {
				// Best-effort: Obsidian versions / mobile drawers may vary.
			}
		}

		// Always place the Connections view into the right sidebar. This is the core "关系视图" UX.
		const ensureSideLeaf = (workspace as unknown as { ensureSideLeaf?: unknown }).ensureSideLeaf;
		let rightLeaf: WorkspaceLeaf | null = null;
		if (typeof ensureSideLeaf === "function") {
			rightLeaf = await (workspace as any).ensureSideLeaf(VIEW_TYPE_CONNECTIONS, "right", {
				active: true,
				reveal,
				split: false,
			});
		} else {
			rightLeaf = workspace.getRightLeaf(true);
			if (rightLeaf) {
				await rightLeaf.setViewState({ type: VIEW_TYPE_CONNECTIONS, active: true });
			}
		}

		// If the leaf is deferred (Obsidian 1.7+), ensure it's loaded even when we avoid focusing it.
		if (rightLeaf && (rightLeaf as unknown as { loadIfDeferred?: unknown }).loadIfDeferred) {
			await (rightLeaf as any).loadIfDeferred();
		}

		if (rightLeaf && reveal) {
			await workspace.revealLeaf(rightLeaf);
		}

		// Auto-open should not steal focus from the editor.
		if (!active && editorLeaf) {
			workspace.setActiveLeaf(editorLeaf, { focus: true });
		}

		// Keep a single Connections view leaf to avoid duplicates and surprise behavior.
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_CONNECTIONS);
		for (const leaf of leaves) {
			if (rightLeaf && leaf === rightLeaf) continue;
			leaf.detach();
		}
	}

	/**
	 * 根据 viewType 激活对应视图。
	 * - ConnectionsView：强制在右侧栏（核心 UX）
	 * - 其它 view：用通用 ensureViewOpen
	 */
	async activateView(viewType: string): Promise<void> {
		if (viewType === VIEW_TYPE_CONNECTIONS) {
			await this.ensureConnectionsViewOpen({ reveal: true, active: true });
			return;
		}

		await this.ensureViewOpen(viewType, { reveal: true });
	}

	/**
	 * 在主编辑区打开某篇笔记，并可选高亮指定行范围。
	 *
	 * `range` 来源：chunk 切分时记录的 0-based 行号范围，用来从“最契合段落预览”
	 * 精确跳转到笔记内部位置。
	 */
	async openNoteInMainLeaf(notePath: string, range?: [number, number]): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) {
			new Notice(`未找到笔记：${notePath}`, 5000);
			return;
		}

		const leaf =
			this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit) ??
			this.app.workspace.getLeaf(false);

		try {
			await leaf.openFile(file, { active: true });
			if (range) {
				this.highlightLineRangeInLeaf(leaf, range);
			}
		} catch (error) {
			console.error("Semantic Connections: failed to open note", notePath, error);
			await this.logRuntimeError("open-note", error, {
				stage: "open-note",
				errorType: "runtime",
				filePath: notePath,
			});
			new Notice("打开笔记失败，请检查控制台或日志。", 6000);
		}
	}

	/**
	 * 在 MarkdownView 中用 editor selection 的方式“高亮并滚动到”某个行范围。
	 * 这是一个纯 UI 操作，不会修改文件内容。
	 */
	private highlightLineRangeInLeaf(leaf: WorkspaceLeaf, range: [number, number]): void {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) {
			return;
		}

		const startValue = range[0];
		const endValue = range[1];
		if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
			return;
		}

		const editor = view.editor;
		const lastLine = editor.lastLine();
		if (!Number.isInteger(lastLine) || lastLine < 0) {
			return;
		}

		const rawStartLine = Math.max(0, Math.floor(startValue));
		const rawEndLine = Math.max(rawStartLine, Math.floor(endValue));
		const startLine = Math.min(rawStartLine, lastLine);
		const endLine = Math.min(rawEndLine, lastLine);

		const toCh = editor.getLine(endLine).length;
		const from = { line: startLine, ch: 0 };
		const to = { line: endLine, ch: toCh };

		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
		editor.focus();
	}

	/**
	 * 把失败任务（FailedTaskManager 持久化）重新加入队列重试。
	 *
	 * 失败任务通常来自：
	 * - 网络问题
	 * - 429 限流
	 * - 临时的远程服务错误
	 *
	 * 如果文件已经不存在或已经被排除目录过滤，则会直接清理该失败项。
	 */
	async retryFailedIndexTasks(): Promise<void> {
		if (this.isRebuilding) {
			new Notice("正在重建索引，请稍后重试失败项。", 6000);
			return;
		}
		if (this.isSyncing) {
			new Notice("正在同步笔记，请稍后重试失败项。", 6000);
			return;
		}

		const paths = this.failedTaskManager.getAllPaths();
		if (paths.length === 0) {
			new Notice("没有需要重试的失败项。", 5000);
			return;
		}

		const isExcluded = (filePath: string): boolean => {
			return this.settings.excludedFolders.some((folder) => {
				return filePath.startsWith(folder + "/") || filePath === folder;
			});
		};

		let removed = 0;
		let queued = 0;

		for (const path of paths) {
			if (isExcluded(path)) {
				if (this.failedTaskManager.resolve(path)) {
					removed++;
				}
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") {
				if (this.failedTaskManager.resolve(path)) {
					removed++;
				}
				continue;
			}

			this.reindexQueue.enqueue({ type: "modify", path: file.path });
			queued++;
		}

		if (removed > 0) {
			await this.failedTaskManager.save();
		}

		if (queued === 0) {
			new Notice("失败项已清理（文件不存在或已被排除）。", 6000);
			return;
		}

		new Notice(`已加入队列：${queued} 个失败项${removed > 0 ? `（已清理 ${removed} 项）` : ""}。`, 7000);

		if (!this.reindexQueue.isProcessing) {
			await this.reindexQueue.flushNow();
		}
	}

	/**
	 * “同步变动笔记”命令的入口：
	 * - 扫描 vault（只扫描 md，并过滤 excludedFolders）
	 * - 找出：新笔记 / 内容 hash 变化 / 被标记为 dirty 的笔记
	 * - 弹窗确认（显示数量 + token 粗略估算）
	 * - 用户确认后再逐篇调用 embeddings API 更新索引
	 */
	async syncChangedNotes(): Promise<void> {
		if (this.isRebuilding) {
			new Notice("正在重建索引，请稍后再同步。", 6000);
			return;
		}
		if (this.isSyncing) {
			new Notice("正在同步笔记，请稍后再试。", 6000);
			return;
		}

		const notice = new Notice("正在扫描 Vault 变动笔记...", 0);
		try {
			const { paths, tokenEstimate } = await this.scanVaultForChangedNotes();
			notice.hide();

			if (paths.length === 0) {
				new Notice("未发现需要同步的笔记。", 5000);
				return;
			}

			new SyncChangedNotesModal(this.app, {
				changedCount: paths.length,
				tokenEstimate,
				onConfirm: async () => {
					await this.syncNotes(paths, { noticeTitle: "正在同步变动笔记..." });
				},
			}).open();
		} catch (error) {
			const diagnostic = normalizeErrorDiagnostic(error);
			notice.setMessage(`扫描失败：${diagnostic.message}`);
			setTimeout(() => notice.hide(), 5000);
			await this.logRuntimeError("sync-changed-notes-scan", error, {
				stage: diagnostic.stage ?? "sync-changed-notes-scan",
			});
		}
	}

	/**
	 * 真正执行“同步”的逻辑（会调用 embeddings API）。
	 *
	 * 为什么这里是“串行 for-loop”而不是并行 Promise.all？
	 * - 避免远程 embeddings API 被瞬间打爆（尤其是批量同步很多笔记）
	 * - 便于更新 notice 进度
	 * - 出错时更容易定位是哪一篇笔记失败
	 */
	async syncNotes(
		paths: string[],
		options?: {
			noticeTitle?: string;
		},
	): Promise<{ total: number; failed: number }> {
		const unique = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
		if (unique.length === 0) {
			return { total: 0, failed: 0 };
		}

		if (this.isRebuilding) {
			new Notice("正在重建索引，请稍后再同步。", 6000);
			return { total: 0, failed: 0 };
		}
		if (this.isSyncing) {
			new Notice("正在同步笔记，请稍后再试。", 6000);
			return { total: 0, failed: 0 };
		}

		const files: TFile[] = [];
		for (const path of unique) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) || file.extension !== "md") {
				continue;
			}
			if (this.isExcludedPath(file.path)) {
				continue;
			}
			files.push(file);
		}

		if (files.length === 0) {
			new Notice("未找到可同步的 Markdown 笔记（可能已被排除或已删除）。", 6000);
			return { total: 0, failed: 0 };
		}

		this.isSyncing = true;
		const notice = options?.noticeTitle ? new Notice(options.noticeTitle, 0) : null;
		let failed = 0;

		try {
			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				notice?.setMessage(`${options?.noticeTitle ?? "正在同步..."}（${i + 1}/${files.length}）`);

				const taskType = this.noteStore.has(file.path) ? "modify" : "create";
				try {
					await this.reindexService.processTask({ type: taskType, path: file.path });
					this.scheduleIndexSave();
				} catch (error) {
					failed++;
					console.error("Semantic Connections: manual sync failed", error);
					await this.logRuntimeError("sync-note", error, {
						stage: "manual-sync",
						filePath: file.path,
					});
				}
			}

			await this.flushIndexSave();
			this.bumpIndexVersion("sync-notes-finished");
		} finally {
			this.isSyncing = false;
		}

		const message =
			failed > 0
				? `同步完成：成功 ${files.length - failed}/${files.length}，失败 ${failed}。`
				: `同步完成：已同步 ${files.length} 篇笔记。`;

		if (notice) {
			notice.setMessage(message);
			setTimeout(() => notice.hide(), failed > 0 ? 6000 : 3000);
		} else {
			new Notice(message, failed > 0 ? 6000 : 3000);
		}

		return { total: files.length, failed };
	}

	/**
	 * 扫描 vault 并找出“需要同步”的笔记路径。
	 *
	 * 同时会做一件小但重要的事：更新 noteStore 中的 dirty/outdated 标记，
	 * 保证 UI（例如 ConnectionsView 的提示条）能反映真实状态。
	 */
	private async scanVaultForChangedNotes(): Promise<{ paths: string[]; tokenEstimate: number }> {
		const files = this.scanner.getMarkdownFiles(this.settings.excludedFolders);
		const paths: string[] = [];
		let tokenEstimate = 0;
		let noteStoreDirty = false;

		for (const file of files) {
			const content = await this.scanner.readContent(file);
			const hash = hashContent(content);

			const existing = this.noteStore.get(file.path);
			const isNew = !existing;
			const isModified = existing ? existing.hash !== hash : false;
			let isMarkedDirty = existing ? Boolean(existing.dirty || existing.outdated) : false;

			if (existing) {
				if (isModified && !isMarkedDirty) {
					this.noteStore.set({ ...existing, dirty: true, outdated: true });
					isMarkedDirty = true;
					noteStoreDirty = true;
				} else if (!isModified && isMarkedDirty) {
					this.noteStore.set({ ...existing, dirty: undefined, outdated: undefined });
					isMarkedDirty = false;
					noteStoreDirty = true;
				}
			}

			if (isNew || isModified || isMarkedDirty) {
				paths.push(file.path);
				tokenEstimate += this.estimateEmbeddingTokensForContent(file.path, content);
			}
		}

		if (noteStoreDirty) {
			this.scheduleIndexSave();
		}

		return { paths, tokenEstimate };
	}

	/**
	 * 估算把一篇笔记发送给 embeddings API 大概会消耗多少 token。
	 *
	 * 这只是一个粗略估算（不同模型的 tokenizer 不同），用于在“同步确认弹窗”里给用户一个量级感知。
	 */
	private estimateEmbeddingTokensForContent(notePath: string, content: string): number {
		const chunks = this.chunker.chunk(notePath, content);
		if (chunks.length === 0) {
			const withoutFm = content.replace(/^---[\s\S]*?---\n*/, "");
			const summary = withoutFm.slice(0, 500).trim();
			return summary ? this.estimateTokensForText(summary) : 0;
		}

		let total = 0;
		for (const chunk of chunks) {
			const heading = this.getHeadingContextForEstimation(chunk.heading);
			const payload = heading ? `${heading}\n\n${chunk.text}` : chunk.text;
			total += this.estimateTokensForText(payload);
		}
		return total;
	}

	/** 辅助 token 估算：heading 太长时截断，避免标题把估算撑爆。 */
	private getHeadingContextForEstimation(heading: string): string {
		const trimmed = heading.trim();
		if (!trimmed) {
			return "";
		}
		if (trimmed.length <= 200) {
			return trimmed;
		}
		return `${trimmed.slice(0, 200).trimEnd()}...`;
	}

	/**
	 * 超轻量 token 估算器：
	 * - CJK（中日韩）字符按 1 字符 ≈ 1 token 估算
	 * - 其它字符按 4 字符 ≈ 1 token 估算
	 *
	 * 目的不是精确，而是提供“同步会不会很贵”的直觉。
	 */
	private estimateTokensForText(text: string): number {
		if (!text) {
			return 0;
		}

		let cjk = 0;
		let other = 0;

		for (const char of text) {
			const code = char.charCodeAt(0);
			const isCjk =
				(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
				(code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
				(code >= 0x3040 && code <= 0x30ff) || // Hiragana/Katakana
				(code >= 0xac00 && code <= 0xd7af); // Hangul Syllables

			if (isCjk) {
				cjk++;
			} else {
				other++;
			}
		}

		return Math.ceil(cjk + other / 4);
	}

	/**
	 * “重建索引”命令入口：完整扫描并重建所有数据。
	 *
	 * 该流程会清空现有索引（store），然后重新生成所有 note/chunk/vector，
	 * 最后把快照写入磁盘。
	 */
	async rebuildIndex(options?: RebuildIndexOptions): Promise<void> {
		if (this.isRebuilding) {
			return;
		}

		this.isRebuilding = true;
		this.indexSnapshotIncompatible = false;
		const emitProgress = (progress: RebuildIndexProgress): void => {
			options?.onProgress?.(progress);
		};
		const notice = new Notice("正在重建语义索引...", 0);

		try {
			emitProgress({
				stage: "preparing",
				message: "正在准备重建索引...",
				percent: 0,
			});

			await this.logRuntimeEvent("rebuild-index-started", "开始完整重建索引。", {
				category: "indexing",
			});
			await this.errorLogger.clear();

			this.clearIndexData();

			const { total, failed } = await this.reindexService.indexAll(
				this.settings.excludedFolders,
				(done, totalNotes) => {
					const percent = totalNotes > 0 ? Math.round((done / totalNotes) * 100) : 100;
					const message =
						totalNotes > 0
							? `正在构建语义索引...（${done}/${totalNotes}）`
							: "没有找到可索引的笔记。";
					emitProgress({
						stage: "indexing",
						message,
						done,
						total: totalNotes,
						percent,
					});
					notice.setMessage(message);
				},
			);

			emitProgress({
				stage: "saving",
				message: "正在将索引保存到磁盘...",
				percent: 100,
			});
			notice.setMessage("正在将索引保存到磁盘...");
			this.settings.lastFullRebuildAt = Date.now();
			await this.saveIndexSnapshot();
			try {
				await this.saveSettings("rebuild-index-metadata");
			} catch {
				// Non-fatal: indexing succeeded even if settings persistence fails.
			}

			this.bumpIndexVersion("rebuild-index-finished");

			const message =
				failed > 0
					? `索引重建完成：已索引 ${this.noteStore.size} 篇笔记，失败 ${failed} 篇。`
					: `索引重建完成：已索引 ${this.noteStore.size} 篇笔记。`;
			emitProgress({
				stage: "success",
				message,
				percent: 100,
				failed,
				indexedNotes: this.noteStore.size,
			});
			notice.setMessage(message);
			await this.logRuntimeEvent(
				"rebuild-index-finished",
				failed > 0
					? "完整重建索引已完成，但存在失败项。"
					: "完整重建索引已成功完成。",
				{
					category: "indexing",
					details: [
						`indexed_notes=${this.noteStore.size}`,
						`failed=${failed}`,
						`total=${total}`,
					],
				},
			);
			setTimeout(() => notice.hide(), failed > 0 ? 5000 : 3000);
		} catch (error) {
			const diagnostic = normalizeErrorDiagnostic(error);
			const message = `索引重建失败：${diagnostic.message}`;
			emitProgress({
				stage: "error",
				message,
				percent: 0,
			});
			notice.setMessage(message);
			console.error("Semantic Connections: rebuild index failed", error);
			await this.logRuntimeEvent("rebuild-index-finished", message, {
				level: "warn",
				category: "indexing",
			});
			await this.logRuntimeError("rebuild-index", error, {
				stage: diagnostic.stage ?? "rebuild-index",
			});
			setTimeout(() => notice.hide(), 5000);
		} finally {
			this.isRebuilding = false;
		}
	}

	/** 构造插件数据目录下某个文件的完整路径。 */
	private getPluginDataPath(filename: string): string {
		return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${filename}`;
	}

	/** 友好的字节数格式化（用于存储统计展示）。 */
	private formatByteSize(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) {
			return "0 B";
		}

		const units = ["B", "KB", "MB", "GB"];
		let value = bytes;
		let unitIndex = 0;
		while (value >= 1024 && unitIndex < units.length - 1) {
			value /= 1024;
			unitIndex++;
		}

		return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
	}

	/**
	 * 读取当前索引快照在磁盘上的大小，并组合出一个“存储概况”对象供 UI 展示。
	 *
	 * 注意：这里读取的是“快照文件”（已落盘）大小；
	 * 内存中的 store 可能还没保存（由 scheduleIndexSave 节流）。
	 */
	async getIndexStorageSummary(): Promise<IndexStorageSummary> {
		const adapter = this.app.vault.adapter;
		const breakdown = this.vectorStore.getBreakdown();
		const jsonStat = this.indexSnapshotPath
			? await adapter.stat(this.indexSnapshotPath).catch(() => null)
			: null;
		const binaryStat = this.indexVectorSnapshotPath
			? await adapter.stat(this.indexVectorSnapshotPath).catch(() => null)
			: null;
		const rawParts = [
			jsonStat?.type === "file"
				? {
					label: "index-store.json",
					path: this.indexSnapshotPath,
					bytes: jsonStat.size,
				}
				: undefined,
			binaryStat?.type === "file"
				? {
					label: "index-vectors.bin",
					path: this.indexVectorSnapshotPath,
					bytes: binaryStat.size,
				}
				: undefined,
		].filter(
			(part): part is { label: string; path: string; bytes: number } => Boolean(part),
		);
		const totalBytes = rawParts.reduce((sum, part) => sum + part.bytes, 0);
		const parts = rawParts.map((part) => ({
			...part,
			share: totalBytes > 0 ? part.bytes / totalBytes : 0,
		}));

		return {
			noteCount: this.noteStore.size,
			chunkCount: this.chunkStore.size,
			vectorCount: breakdown.vectorCount,
			noteVectorCount: breakdown.noteVectorCount,
			chunkVectorCount: breakdown.chunkVectorCount,
			embeddingDimension: breakdown.dimension,
			snapshotFormat:
				binaryStat?.type === "file"
					? "json+binary"
					: jsonStat?.type === "file"
						? "json-only"
						: "missing",
			parts,
			totalBytes,
		};
	}

	/** 把索引存储统计以 Notice 的形式展示出来（并同步输出到控制台）。 */
	async showIndexStorageSummary(): Promise<void> {
		try {
			const summary = await this.getIndexStorageSummary();
			const snapshotFormatLabel =
				summary.snapshotFormat === "json+binary"
					? "JSON + 二进制"
					: summary.snapshotFormat === "json-only"
						? "仅 JSON"
						: "缺失";
			const lines = [
				`索引概况：${summary.noteCount} 篇笔记，${summary.chunkCount} 个语义分块，${summary.vectorCount} 个向量`,
				`向量明细：笔记=${summary.noteVectorCount}，分块=${summary.chunkVectorCount}，维度=${summary.embeddingDimension}`,
				`快照格式：${snapshotFormatLabel}`,
			];

			if (summary.parts.length > 0) {
				lines.push(
					`总大小：${this.formatByteSize(summary.totalBytes)}`,
					...summary.parts.flatMap((part) => [
						`${part.label}: ${this.formatByteSize(part.bytes)} (${(part.share * 100).toFixed(1)}%)`,
						`路径：${part.path}`,
					]),
				);
			} else {
				lines.push("未找到已持久化的索引快照文件。");
			}

			new Notice(lines.join("\n"), 12000);
			console.info("Semantic Connections index storage summary\n" + lines.join("\n"));
		} catch (error) {
			new Notice("读取索引存储统计失败，请检查错误日志。", 6000);
			await this.logRuntimeError("show-index-storage-summary", error, {
				stage: "index-storage-summary",
				errorType: "storage",
				filePath: this.indexSnapshotPath || "__plugin__/index-storage-summary",
				details: [
					this.indexVectorSnapshotPath
						? `vector_binary_path=${this.indexVectorSnapshotPath}`
						: undefined,
				].filter((item): item is string => Boolean(item)),
			});
			console.error("Semantic Connections: failed to show index storage summary", error);
		}
	}

	/**
	 * 从磁盘读取索引快照并恢复到内存 store。
	 *
	 * 关键点：在恢复前会做兼容性校验（provider/model/dimension/strategy）。
	 * 不兼容就跳过加载，让用户手动重建索引，避免“用错向量导致结果乱飞”。
	 */
	private async loadIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath) {
			return;
		}

		try {
			if (!(await this.app.vault.adapter.exists(this.indexSnapshotPath))) {
				return;
			}

			const raw = await this.app.vault.adapter.read(this.indexSnapshotPath);
			const snapshot = JSON.parse(raw) as PersistedIndexSnapshot;

			if (!snapshot || typeof snapshot !== "object") {
				throw new Error("Index snapshot payload is invalid.");
			}
			if (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3) {
				throw new Error(`Unsupported index snapshot version: ${String(snapshot.version)}`);
			}

			const missingStores = ["noteStore", "chunkStore", "vectorStore"].filter((key) => {
				const value = snapshot[key as keyof PersistedIndexSnapshot];
				return value === undefined || value === null;
			});
			if (missingStores.length > 0) {
				throw new Error(`Index snapshot is incomplete: ${missingStores.join(", ")}`);
			}

			const providerMismatch =
				typeof snapshot.embeddingProvider === "string" &&
				snapshot.embeddingProvider !== this.settings.embeddingProvider;

			const remoteConfigMismatch =
				this.settings.embeddingProvider === "remote" &&
				((typeof snapshot.remoteModel === "string" &&
					snapshot.remoteModel !== this.settings.remoteModel.trim()) ||
					(typeof snapshot.remoteBaseUrl === "string" &&
						snapshot.remoteBaseUrl !== normalizeRemoteBaseUrl(this.settings.remoteBaseUrl)));

			const dimensionMismatch =
				typeof snapshot.embeddingDimension === "number" &&
				snapshot.embeddingDimension > 0 &&
				this.embeddingService.dimension > 0 &&
				snapshot.embeddingDimension !== this.embeddingService.dimension;

			const chunkingStrategyMismatch =
				snapshot.chunkingStrategy !== CURRENT_CHUNKING_STRATEGY;

			const noteVectorStrategyMismatch =
				snapshot.noteVectorStrategy !== CURRENT_NOTE_VECTOR_STRATEGY;

			if (
				providerMismatch ||
				remoteConfigMismatch ||
				dimensionMismatch ||
				chunkingStrategyMismatch ||
				noteVectorStrategyMismatch
			) {
				this.indexSnapshotIncompatible = true;
				new Notice("检测到当前嵌入、切分或笔记向量策略与已有索引快照不兼容，已跳过加载。请手动重建索引。", 8000);
				return;
			}

			if (typeof snapshot.lastFullRebuildAt === "number" && snapshot.lastFullRebuildAt > 0) {
				this.settings.lastFullRebuildAt = snapshot.lastFullRebuildAt;
			} else if (
				this.settings.lastFullRebuildAt <= 0 &&
				typeof snapshot.savedAt === "number" &&
				snapshot.savedAt > 0
			) {
				// Backward compatible fallback for older snapshots that did not persist lastFullRebuildAt.
				this.settings.lastFullRebuildAt = snapshot.savedAt;
			}

			this.noteStore.load(snapshot.noteStore);
			this.chunkStore.load(snapshot.chunkStore);
			if (snapshot.version === 2 || snapshot.version === 3) {
				const vectorBinaryPath =
					typeof snapshot.vectorBinaryPath === "string" && snapshot.vectorBinaryPath.length > 0
						? snapshot.vectorBinaryPath
						: this.indexVectorSnapshotPath;
				if (!(await this.app.vault.adapter.exists(vectorBinaryPath))) {
					throw new Error(`Vector snapshot binary is missing: ${vectorBinaryPath}`);
				}
				const binary = await this.app.vault.adapter.readBinary(vectorBinaryPath);
				this.vectorStore.loadBinary(snapshot.vectorStore, binary);
			} else {
				this.vectorStore.load(snapshot.vectorStore);
			}

			this.bumpIndexVersion("index-snapshot-loaded");

			await this.logRuntimeEvent("index-snapshot-loaded", "已从磁盘恢复索引快照。", {
				category: "storage",
				details: [
					`notes=${this.noteStore.size}`,
					`chunks=${this.chunkStore.size}`,
					`vectors=${this.vectorStore.size}`,
				],
			});

			console.log(
				`Semantic Connections: index loaded (notes=${this.noteStore.size}, chunks=${this.chunkStore.size}, vectors=${this.vectorStore.size})`,
			);
		} catch (error) {
			this.clearIndexData();
			await this.logRuntimeError("load-index-snapshot", error, {
				stage: "index-snapshot-load",
				errorType: "storage",
				filePath: this.indexSnapshotPath,
			});
			console.warn("Semantic Connections: failed to load index snapshot, starting fresh", error);
		}
	}

	/**
	 * 把当前 store 序列化成快照并写入磁盘。
	 *
	 * 写入策略：
	 * - 先写到 `.tmp` 再 rename，尽量做到“原子替换”，避免半写入导致快照损坏
	 * - 向量用二进制文件存储（`index-vectors.bin`），JSON 里只放元数据
	 */
	private async saveIndexSnapshot(): Promise<void> {
		if (!this.indexSnapshotPath || !this.indexVectorSnapshotPath) {
			return;
		}

		const replaceTextFile = async (path: string, contents: string): Promise<void> => {
			const tmpPath = path + ".tmp";
			await this.app.vault.adapter.write(tmpPath, contents);
			try {
				await this.app.vault.adapter.rename(tmpPath, path);
			} catch {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
				await this.app.vault.adapter.rename(tmpPath, path);
			}
		};

		const replaceBinaryFile = async (path: string, contents: ArrayBuffer): Promise<void> => {
			const tmpPath = path + ".tmp";
			await this.app.vault.adapter.writeBinary(tmpPath, contents);
			try {
				await this.app.vault.adapter.rename(tmpPath, path);
			} catch {
				if (await this.app.vault.adapter.exists(path)) {
					await this.app.vault.adapter.remove(path);
				}
				await this.app.vault.adapter.rename(tmpPath, path);
			}
		};

		try {
			const vectorSnapshot = this.vectorStore.serializeBinary();
			const snapshot: PersistedIndexSnapshot = {
				version: CURRENT_INDEX_SNAPSHOT_VERSION,
				savedAt: Date.now(),
				lastFullRebuildAt:
					this.settings.lastFullRebuildAt > 0 ? this.settings.lastFullRebuildAt : undefined,
				embeddingProvider: this.settings.embeddingProvider,
				embeddingDimension: this.embeddingService.dimension,
				remoteBaseUrl:
					this.settings.embeddingProvider === "remote"
						? normalizeRemoteBaseUrl(this.settings.remoteBaseUrl)
						: undefined,
				remoteModel:
					this.settings.embeddingProvider === "remote"
						? this.settings.remoteModel.trim()
						: undefined,
				chunkingStrategy: CURRENT_CHUNKING_STRATEGY,
				noteVectorStrategy: CURRENT_NOTE_VECTOR_STRATEGY,
				vectorBinaryPath: this.indexVectorSnapshotPath,
				noteStore: this.noteStore.serialize(),
				chunkStore: this.chunkStore.serialize(),
				vectorStore: vectorSnapshot.metadata,
			};

			const serialized = JSON.stringify(snapshot, null, 2);
			await replaceBinaryFile(this.indexVectorSnapshotPath, vectorSnapshot.buffer);
			await replaceTextFile(this.indexSnapshotPath, serialized);
		} catch (error) {
			await this.logRuntimeError("save-index-snapshot", error, {
				stage: "index-snapshot-save",
				errorType: "storage",
				filePath: this.indexSnapshotPath,
				details: [`vector_binary_path=${this.indexVectorSnapshotPath}`],
			});
			console.error("Semantic Connections: failed to save index snapshot", error);
		}
	}

	/**
	 * 如果距离上次全量重建超过设定天数（默认 7 天），在启动时提示用户手动重建。
	 *
	 * 目的：提示用户“索引可能过期”，但仍然保持“不会自动消耗 API”的设计原则。
	 */
	private async maybeNotifyWeeklyRebuildReminder(): Promise<void> {
		const lastFullRebuildAt = this.settings.lastFullRebuildAt;
		if (!Number.isFinite(lastFullRebuildAt) || lastFullRebuildAt <= 0) {
			return;
		}

		const now = Date.now();
		const delta = now - lastFullRebuildAt;
		if (!Number.isFinite(delta) || delta < 0) {
			return;
		}

		const daysSince = Math.floor(delta / MS_PER_DAY);
		if (daysSince < FULL_REBUILD_REMINDER_DAYS) {
			return;
		}

		const lastText = new Date(lastFullRebuildAt).toLocaleString();
		new Notice(
			`索引已 ${daysSince} 天未全量重建（上次：${lastText}）。如需更新，请手动执行“重建索引”。`,
			9000,
		);
		await this.logRuntimeEvent(
			"startup-weekly-rebuild-reminder",
			"检测到索引超过设定周期未全量重建，已提示用户手动重建。",
			{
				category: "lifecycle",
				details: [
					`days_since_last_full_rebuild=${daysSince}`,
					`last_full_rebuild_at=${lastFullRebuildAt}`,
				],
			},
		);
	}

	/** 标记索引有变更，并在后台（节流后）保存快照。 */
	private scheduleIndexSave(): void {
		this.indexSavePending = true;
		this.cancelIndexSaveTimer();
		this.indexSaveTimer = setTimeout(() => {
			void this.flushIndexSave();
		}, 10_000);
	}

	/** 取消正在等待的保存 timer（通常用于重新 schedule 或 unload 清理）。 */
	private cancelIndexSaveTimer(): void {
		if (this.indexSaveTimer) {
			clearTimeout(this.indexSaveTimer);
			this.indexSaveTimer = null;
		}
	}

	/**
	 * 立即（或等待当前保存完成后）把 pending 的快照保存落盘。
	 *
	 * 这里用 `indexSaveInProgress` 做互斥锁，避免并发写同一个文件：
	 * - 如果保存正在进行，后续调用会 await 同一个 promise
	 * - 如果保存过程中又 schedule 了新的 pending，会在 while 循环里继续保存一次
	 */
	private async flushIndexSave(): Promise<void> {
		if (!this.indexSavePending) {
			return;
		}

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




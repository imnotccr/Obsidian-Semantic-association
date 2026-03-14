/**
 * Plugin entrypoint.
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

type RuntimeErrorLogOptions = {
	errorType?: IndexErrorEntry["errorType"];
	filePath?: string;
	details?: string[];
	provider?: string;
	stage?: string;
};

type RuntimeEventLogOptions = {
	level?: RuntimeLogLevel;
	category?: RuntimeLogCategory;
	details?: string[];
	provider?: string;
};

type RebuildIndexOptions = {
	onProgress?: (progress: RebuildIndexProgress) => void;
};

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

const CURRENT_INDEX_SNAPSHOT_VERSION = 3;
const CURRENT_CHUNKING_STRATEGY = "paragraph-first-v3-overlap20";
const CURRENT_NOTE_VECTOR_STRATEGY = "chunk-mean-v1";
const FULL_REBUILD_REMINDER_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export default class SemanticConnectionsPlugin extends Plugin {
	settings: SemanticConnectionsSettings = DEFAULT_SETTINGS;

	noteStore!: NoteStore;
	chunkStore!: ChunkStore;
	vectorStore!: VectorStore;
	embeddingService!: EmbeddingService;
	connectionsService!: ConnectionsService;
	lookupService!: LookupService;
	errorLogger!: ErrorLogger;
	runtimeLogger!: RuntimeLogger;
	failedTaskManager!: FailedTaskManager;

	private scanner!: Scanner;
	private chunker!: Chunker;
	private reindexService!: ReindexService;
	private reindexQueue!: ReindexQueue;

	private indexSnapshotPath = "";
	private indexVectorSnapshotPath = "";
	private indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
	private indexSaveInProgress: Promise<void> | null = null;
	private indexSavePending = false;
	private indexSnapshotIncompatible = false;

	isRebuilding = false;
	isSyncing = false;
	private indexVersionValue = 0;

	private dirtyCheckTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private indexingStatusBar: HTMLElement | null = null;

	get indexVersion(): number {
		return this.indexVersionValue;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.createServices();
		await this.failedTaskManager.load();
		this.registerGlobalErrorHandlers();

		this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(VIEW_TYPE_LOOKUP, (leaf) => new LookupView(leaf, this));

		this.addRibbonIcon("link", "Show Connections View", () => {
			void this.activateView(VIEW_TYPE_CONNECTIONS);
		});

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

		this.indexingStatusBar = this.addStatusBarItem();
		this.indexingStatusBar.hide();

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

	clearIndexData(): void {
		this.noteStore.clear();
		this.chunkStore.clear();
		this.vectorStore.clear();
		this.bumpIndexVersion("index-cleared");
	}

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

	private createServices(): void {
		this.indexSnapshotPath = this.getPluginDataPath("index-store.json");
		this.indexVectorSnapshotPath = this.getPluginDataPath("index-vectors.bin");

		const logPath = this.getPluginDataPath("error-log.json");
		this.errorLogger = new ErrorLogger(this.app.vault.adapter, logPath);
		const runtimeLogPath = this.getPluginDataPath("runtime-log.json");
		this.runtimeLogger = new RuntimeLogger(this.app.vault.adapter, runtimeLogPath);
		const failedTaskPath = this.getPluginDataPath("failed-tasks.json");
		this.failedTaskManager = new FailedTaskManager(this.app.vault.adapter, failedTaskPath);

		this.noteStore = new NoteStore();
		this.chunkStore = new ChunkStore();
		this.vectorStore = new VectorStore();

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
			this.failedTaskManager,
		);

		this.reindexQueue = new ReindexQueue();
		this.reindexQueue.setExecutor(async (task) => {
			try {
				await this.reindexService.processTask(task);
			} finally {
				this.scheduleIndexSave();
			}
		});
		this.reindexQueue.setFlushCallbacks({
			onFlushStart: (taskCount) => {
				this.setIndexingStatus(true, taskCount);
			},
			onFlushEnd: (succeeded, failed) => {
				this.setIndexingStatus(false, succeeded, failed);
			},
		});

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
			// 快照加载成功后，若开启了自动索引，静默入队启动时的新增/待同步文件
			if (this.settings.autoIndex) {
				void this.enqueueStartupDirtyFiles();
			}
		}

		await this.logRuntimeEvent("plugin-ready", "插件启动完成。", {
			category: "lifecycle",
		});
		console.log("Semantic Connections: ready");
	}

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

	private isExcludedPath(path: string): boolean {
		return this.settings.excludedFolders.some(
			(folder) => path.startsWith(folder + "/") || path === folder,
		);
	}

	private clearDirtyCheckTimers(): void {
		for (const timer of this.dirtyCheckTimers.values()) {
			clearTimeout(timer);
		}
		this.dirtyCheckTimers.clear();
	}

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
	 * 更新状态栏中的索引进度指示器，并在完成时发出 Notice。
	 *
	 * @param active   true = 索引正在进行；false = 本批次已完成
	 * @param count    active=true 时为本批次任务数；active=false 时为成功数
	 * @param failed   active=false 时的失败数（默认 0）
	 */
	private setIndexingStatus(active: boolean, count = 0, failed = 0): void {
		if (!this.indexingStatusBar) return;

		if (active) {
			this.indexingStatusBar.setText(`↻ 正在索引... (${count} 篇)`);
			this.indexingStatusBar.show();
		} else {
			// 若队列中仍有后续任务，保持状态栏可见（下一批 onFlushStart 会更新文字）
			if (this.reindexQueue.pendingCount > 0) return;

			this.indexingStatusBar.hide();

			if (failed > 0) {
				new Notice(`索引完成：${count} 篇成功，${failed} 篇失败。`, 5000);
			} else if (count > 0) {
				new Notice(`已更新 ${count} 篇笔记的索引。`, 3000);
			}
		}
	}

	/**
	 * 启动时静默入队待处理文件（增量索引）
	 *
	 * 在 onLayoutReady 中，快照加载成功且 autoIndex=true 时调用。
	 * 扫描 vault 中所有未排除的 .md 文件，将以下两类入队：
	 * - 不在 noteStore 的文件（插件未启动期间新增的笔记）
	 * - noteStore 中已标记 dirty/outdated 的文件
	 *
	 * 不读取文件内容做 hash 比对（避免启动时大量 I/O），
	 * 实际的 hash 二次确认由 indexFile() 内部完成。
	 */
	private async enqueueStartupDirtyFiles(): Promise<void> {
		if (!this.settings.remoteBaseUrl.trim() || !this.settings.remoteApiKey.trim()) {
			// 远程配置不完整时跳过（请求也会立即失败，无意义入队）
			return;
		}
		const files = this.scanner.getMarkdownFiles(this.settings.excludedFolders);
		let queued = 0;
		for (const file of files) {
			const existing = this.noteStore.get(file.path);
			if (!existing || existing.dirty || existing.outdated) {
				this.reindexQueue.enqueue({ type: "modify", path: file.path });
				queued++;
			}
		}
		if (queued > 0) {
			await this.logRuntimeEvent(
				"startup-incremental-queue",
				`启动时自动入队 ${queued} 个新增或待同步笔记。`,
				{ category: "lifecycle" },
			);
		}
	}

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
			// 新文件（noteStore 中没有记录）→ 直接入队增量索引
			this.reindexQueue.enqueue({ type: "modify", path: file.path });
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const hash = hashContent(content);
		const isOutdated = existing.hash !== hash;

		if (isOutdated) {
			// 内容已变更 → 直接入队重新 embed（indexFile 内部仍会做 hash 二次确认）
			this.reindexQueue.enqueue({ type: "modify", path: file.path });
			return;
		}

		// 内容未变但有脏标记（如之前标记后内容被回滚）→ 清除标记
		if (existing.dirty || existing.outdated) {
			this.noteStore.set({ ...existing, dirty: undefined, outdated: undefined });
			this.scheduleIndexSave();
		}
	}

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

	async activateView(viewType: string): Promise<void> {
		if (viewType === VIEW_TYPE_CONNECTIONS) {
			await this.ensureConnectionsViewOpen({ reveal: true, active: true });
			return;
		}

		await this.ensureViewOpen(viewType, { reveal: true });
	}

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

	private getPluginDataPath(filename: string): string {
		return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${filename}`;
	}

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

	private scheduleIndexSave(): void {
		this.indexSavePending = true;
		this.cancelIndexSaveTimer();
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




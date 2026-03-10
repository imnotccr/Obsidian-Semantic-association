/**
 * Plugin entrypoint.
 */

import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
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
import { RuntimeLogger } from "./utils/runtime-logger";
import { ConnectionsView, VIEW_TYPE_CONNECTIONS } from "./views/connections-view";
import { LookupView, VIEW_TYPE_LOOKUP } from "./views/lookup-view";

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
	embeddingProvider?: string;
	embeddingDimension?: number;
	remoteBaseUrl?: string;
	remoteModel?: string;
	chunkingStrategy?: string;
	vectorBinaryPath?: string;
	noteStore?: unknown;
	chunkStore?: unknown;
	vectorStore?: unknown;
};

const CURRENT_INDEX_SNAPSHOT_VERSION = 3;
const CURRENT_CHUNKING_STRATEGY = "paragraph-first-v2";

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

	async onload(): Promise<void> {
		await this.loadSettings();
		this.createServices();
		this.registerGlobalErrorHandlers();

		this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsView(leaf, this));
		this.registerView(VIEW_TYPE_LOOKUP, (leaf) => new LookupView(leaf, this));

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
			id: "show-index-storage-summary",
			name: "显示索引统计",
			callback: () => {
				void this.showIndexStorageSummary();
			},
		});

		this.addSettingTab(new SettingTab(this.app, this));

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
		this.cancelIndexSaveTimer();
		this.indexSavePending = true;
		void this.flushIndexSave();
		void this.embeddingService?.disposeCurrentProvider().catch(() => undefined);
		void this.runtimeLogger?.save();
		void this.errorLogger?.save();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<SemanticConnectionsSettings> & Record<string, unknown>)
			| null;
		const loaded = raw ?? {};
		const storedEmbeddingProvider =
			typeof loaded.embeddingProvider === "string" ? loaded.embeddingProvider : "";
		const embeddingProvider =
			storedEmbeddingProvider === "mock" || storedEmbeddingProvider === "remote"
				? storedEmbeddingProvider
				: DEFAULT_SETTINGS.embeddingProvider;

		this.settings = {
			maxConnections:
				typeof loaded.maxConnections === "number"
					? loaded.maxConnections
					: DEFAULT_SETTINGS.maxConnections,
			excludedFolders: Array.isArray(loaded.excludedFolders)
				? loaded.excludedFolders.filter((folder): folder is string => typeof folder === "string")
				: DEFAULT_SETTINGS.excludedFolders,
			embeddingProvider,
			autoIndex:
				typeof loaded.autoIndex === "boolean"
					? loaded.autoIndex
					: DEFAULT_SETTINGS.autoIndex,
			autoOpenConnectionsView:
				typeof loaded.autoOpenConnectionsView === "boolean"
					? loaded.autoOpenConnectionsView
					: DEFAULT_SETTINGS.autoOpenConnectionsView,
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

	clearIndexData(): void {
		this.noteStore.clear();
		this.chunkStore.clear();
		this.vectorStore.clear();
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
		);

		this.reindexQueue = new ReindexQueue();
		this.reindexQueue.setExecutor(async (task) => {
			try {
				await this.reindexService.processTask(task);
			} finally {
				this.scheduleIndexSave();
			}
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
		await this.logRuntimeEvent("startup-sequence-started", "插件进入 layout-ready 阶段。", {
			category: "lifecycle",
		});

		await this.loadIndexSnapshot();
		this.registerFileEvents();

		if (this.settings.autoOpenConnectionsView) {
			await this.ensureViewOpen(VIEW_TYPE_CONNECTIONS);
			await this.logRuntimeEvent("connections-view-auto-opened", "已自动打开关联视图。", {
				category: "lifecycle",
			});
		}

		if (this.noteStore.size === 0) {
			if (this.indexSnapshotIncompatible) {
				new Notice("索引快照与当前 embedding 配置或切块策略不兼容，请手动执行“重建索引”。", 8000);
			} else if (
				this.settings.embeddingProvider === "remote" &&
				(!this.settings.remoteBaseUrl.trim() || !this.settings.remoteApiKey.trim())
			) {
				new Notice(
					"当前使用远程 embeddings，但 API Base URL 或 API Key 未配置。请先完成配置，再手动执行“重建索引”。",
					8000,
				);
				await this.logRuntimeEvent(
					"startup-auto-rebuild-skipped",
					"已跳过启动时自动重建，因为远程 embeddings 配置不完整。",
					{
						category: "lifecycle",
						provider: "remote",
					},
				);
			} else {
				await this.rebuildIndex();
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
				this.reindexQueue.enqueue({ type: "create", path: file.path });
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
				this.reindexQueue.enqueue({ type: "modify", path: file.path });
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
					if (!this.isExcludedPath(newPath)) {
						this.reindexQueue.enqueue({ type: "create", path: newPath });
					}
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
					this.reindexQueue.enqueue({ type: "create", path: newPath });
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

	private async ensureViewOpen(viewType: string, options?: { reveal?: boolean }): Promise<void> {
		const { workspace } = this.app;
		const reveal = options?.reveal ?? false;

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

		if (leaf && reveal) {
			workspace.revealLeaf(leaf);
		}
	}

	async activateView(viewType: string): Promise<void> {
		await this.ensureViewOpen(viewType, { reveal: true });
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

			await this.logRuntimeEvent("rebuild-index-started", "开始全量重建索引。", {
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
							? `正在构建语义索引... (${done}/${totalNotes})`
							: "没有发现需要索引的笔记";
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
				message: "正在保存索引到磁盘...",
				percent: 100,
			});
			notice.setMessage("正在保存索引到磁盘...");
			await this.saveIndexSnapshot();

			const message =
				failed > 0
					? `索引完成：${this.noteStore.size} 篇笔记，失败 ${failed} 篇。`
					: `索引完成：${this.noteStore.size} 篇笔记。`;
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
				failed > 0 ? "全量重建索引完成，但存在失败项。" : "全量重建索引完成。",
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
			const message = `重建索引失败：${diagnostic.message}`;
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
			const lines = [
				`索引统计：${summary.noteCount} 篇笔记，${summary.chunkCount} 个语义块，${summary.vectorCount} 个向量`,
				`向量细分：note=${summary.noteVectorCount}，chunk=${summary.chunkVectorCount}，dimension=${summary.embeddingDimension}`,
				`快照格式：${summary.snapshotFormat}`,
			];

			if (summary.parts.length > 0) {
				lines.push(
					`总占用：${this.formatByteSize(summary.totalBytes)}`,
					...summary.parts.flatMap((part) => [
						`${part.label}: ${this.formatByteSize(part.bytes)} (${(part.share * 100).toFixed(1)}%)`,
						`路径：${part.path}`,
					]),
				);
			} else {
				lines.push("尚未检测到已落盘的索引快照文件。");
			}

			new Notice(lines.join("\n"), 12000);
			console.info("Semantic Connections index storage summary\n" + lines.join("\n"));
		} catch (error) {
			new Notice("读取索引存储统计失败，请查看错误日志。", 6000);
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

			if (
				providerMismatch ||
				remoteConfigMismatch ||
				dimensionMismatch ||
				chunkingStrategyMismatch
			) {
				this.indexSnapshotIncompatible = true;
				new Notice(
					"检测到索引快照与当前 embedding 配置或切块策略不兼容，已跳过加载。请手动执行“重建索引”。",
					8000,
				);
				return;
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

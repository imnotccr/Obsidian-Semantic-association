/**
 * 全项目共享的类型定义（Types）。
 *
 * 你可以把它当作“领域模型（Domain Model）+ 配置模型（Settings）”：
 * - Domain：Note / Chunk / Vector / Search Result 这些核心数据结构
 * - Settings：插件可配置项（在 `data.json` 持久化）
 * - Logging：运行日志与错误日志条目结构（持久化到 json 文件）
 *
 * 阅读建议：
 * 1) 先看 `NoteMeta` / `ChunkMeta`，理解插件索引里保存了什么
 * 2) 再看 `ConnectionResult` / `LookupResult`，理解 UI 需要展示什么
 * 3) 最后看 `SemanticConnectionsSettings` 与 `DEFAULT_SETTINGS`，理解用户能改哪些行为
 */

/**
 * 向量表示（embedding vector）。
 *
 * - chunk 向量：对某个分块文本生成的 embedding
 * - note 向量：把同一篇 note 的多个 chunk 向量聚合得到（见 VectorStore 的策略）
 *
 * 这里在内存中用 `number[]` 表示；落盘时 `VectorStore` 会转成 `Float32Array` 的二进制快照，
 * 以减少 JSON 体积并加速加载。
 */
export type Vector = number[];

/**
 * 统一的错误诊断结构。
 *
 * 设计目的：把各种形态的 error（string、Error、任意 object）规范化成可记录/可展示的字段集合，
 * 便于写入 error-log.json，以及在 UI/Notice 中显示。
 */
export interface ErrorDiagnostic {
	message: string;
	name?: string;
	code?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

export type RuntimeLogLevel = "info" | "warn";

/** 运行日志分类：用于把事件按功能域分组（启动、索引、嵌入、存储等）。 */
export type RuntimeLogCategory =
	| "lifecycle"
	| "indexing"
	| "embedding"
	| "storage"
	| "configuration"
	| "query";

/**
 * 运行日志条目（会持久化到 runtime-log.json）。
 *
 * 与 error log 的区别：
 * - runtime log：记录“发生了什么”（时间线）
 * - error log：记录“出了什么错”（诊断信息）
 */
export interface RuntimeLogEntry {
	timestamp: number;
	event: string;
	level: RuntimeLogLevel;
	category: RuntimeLogCategory;
	message: string;
	provider?: string;
	details?: string[];
}

/**
 * 一篇笔记在索引中的元信息（note-level）。
 *
 * 注意：插件不会修改你的 Markdown 文件；这些都是“旁路数据”，保存在插件目录里。
 */
export interface NoteMeta {
	/** vault 内的相对路径（也是本插件索引的主键） */
	path: string;
	/** 展示用标题（通常取文件名或 frontmatter title） */
	title: string;
	/** 文件最后修改时间（ms since epoch） */
	mtime: number;
	/** 内容 hash：用于判断是否变动（是否需要重新索引） */
	hash: string;
	/**
	 * 内容已变更但尚未重新索引。
	 * dirty/outdated 语义等价：outdated 为兼容字段。
	 */
	/** 标记：笔记内容已变更但尚未重新索引。 */
	dirty?: boolean;
	/** 兼容字段：与 dirty 语义等价（旧版本字段名）。 */
	outdated?: boolean;
	/** 标签列表（来自 Obsidian metadataCache）。 */
	tags: string[];
	/** 出链列表（链接到的其它笔记/资源）。 */
	outgoingLinks: string[];
	/** 用于 UI 预览的摘要文本（通常是截取内容前若干字符）。 */
	summaryText: string;
	/** 可选：整篇笔记的“聚合向量”（note vector），用于加速 note-level 粗排。 */
	vector?: Vector;
}

/**
 * 笔记分块（chunk-level）的元信息。
 *
 * Chunk 是语义检索的最小单位：一篇笔记会切成多个 chunk，每个 chunk 生成一个 embedding 向量。
 */
export interface ChunkMeta {
	/** chunk 唯一 id（通常由 notePath + order 等信息组合而成） */
	chunkId: string;
	/** 所属笔记路径（NoteMeta.path） */
	notePath: string;
	/** chunk 所在的标题上下文（用于展示/增强语义） */
	heading: string;
	/** chunk 的纯文本内容（发送到 embeddings API 的主体） */
	text: string;
	/** chunk 在笔记中的顺序（从 0 开始） */
	order: number;
	/**
	 * 源笔记中的行号范围（0-based）[startLine, endLine]。
	 *
	 * 用途：从搜索/关联结果点击时，可以精确跳转并高亮对应的段落范围。
	 */
	range: [number, number];
	/** chunk 的 embedding 向量（可选：可能尚未生成或被清理） */
	vector?: Vector;
}

/**
 * “关联视图”里的一条相关笔记结果。
 *
 * 它通常由 `ConnectionsService` 计算得出，并由 `ConnectionsView` 渲染。
 */
export interface ConnectionResult {
	/** 相关笔记路径 */
	notePath: string;
	/** 相关笔记标题 */
	title: string;
	/** 最终用于排序/展示的综合分数（实现上通常会结合 noteScore 与 passageScore）。 */
	score: number;
	/** note-level 相似度（整篇笔记向量的相似度）。 */
	noteScore: number;
	/** passage-level 相似度（最契合段落/分块的相似度）。 */
	passageScore: number;
	/** 最相关的一段（用于 UI 预览与点击跳转）。 */
	bestPassage: PassageResult;
	/** 可选：更多相关段落（用于展开查看）。 */
	passages: PassageResult[];
}

/**
 * 某个 chunk（段落/分块）与查询向量的匹配结果。
 *
 * 该结果既用于：
 * - ConnectionsView：展示“最契合段落”
 * - LookupView：展示“搜索命中段落”
 */
export interface PassageResult {
	/** 命中的 chunkId（可用于定位到 ChunkMeta.range 并跳转高亮） */
	chunkId: string;
	/** 标题上下文（用于 UI 展示） */
	heading: string;
	/** 片段正文（用于预览） */
	text: string;
	/** chunk 向量相似度分数（通常是 cosine similarity） */
	score: number;
}

/**
 * “语义搜索”结果：一篇笔记 + 该笔记中最匹配的 passage。
 *
 * Lookup 的计算方式通常是：
 * 1) 把 query 文本 embed 成向量
 * 2) 在所有 chunk 向量里做相似度检索
 * 3) 将命中 chunk 归并到对应 note，并挑出每个 note 的 best passage
 */
export interface LookupResult {
	/** 命中的笔记路径 */
	notePath: string;
	/** 命中的笔记标题 */
	title: string;
	/** 该笔记中最匹配的段落 */
	passage: PassageResult;
	/** 分数（通常等于 passage.score，或在实现中做了轻微加权） */
	score: number;
}

/**
 * 插件设置（会持久化到 `data.json`）。
 *
 * 注意：涉及 embeddings provider/model/dimension 的配置变更，通常需要重建索引。
 */
export interface SemanticConnectionsSettings {
	/** 关联视图最多展示多少篇相关笔记 */
	maxConnections: number;
	/** 最低相似度阈值（0~1），用于过滤/标记弱关联 */
	minSimilarityScore: number;
	/** 每篇相关笔记最多展示多少个相关段落（0 表示不限制） */
	maxPassagesPerNote: number;
	/** 索引/搜索时需要跳过的目录列表（vault 相对路径） */
	excludedFolders: string[];
	/** 当前只支持 remote provider（请求外部 embeddings 服务）。 */
	embeddingProvider: "remote";
	/** 是否监听文件变动，并自动对受影响笔记执行增量索引。 */
	autoIndex: boolean;
	/** 启动后是否自动打开关联视图（右侧栏）。 */
	autoOpenConnectionsView: boolean;
	/**
	 * 上次全量重建索引的时间戳（毫秒）。
	 *
	 * 用于启动时的“索引过期提醒”（例如 7 天未重建则提示用户）。
	 */
	lastFullRebuildAt: number;
	/** 远程 embeddings 服务地址（基础 URL）。 */
	remoteBaseUrl: string;
	/** 远程 embeddings API Key（Bearer Token）。 */
	remoteApiKey: string;
	/** 远程模型名（由后端解释）。 */
	remoteModel: string;
	/** 请求超时（毫秒）。 */
	remoteTimeoutMs: number;
	/** 单次请求最多发送多少条文本（batch size）。 */
	remoteBatchSize: number;
}

/** 错误日志分类（用于统计与 UI 展示）。 */
export type ErrorLogType =
	| "embedding"
	| "scanning"
	| "chunking"
	| "storage"
	| "query"
	| "runtime"
	| "configuration"
	| "unknown";

/** error-log.json 的单条记录结构。 */
export interface IndexErrorEntry {
	timestamp: number;
	filePath: string;
	errorType: ErrorLogType;
	message: string;
	provider?: string;
	errorName?: string;
	errorCode?: string;
	stage?: string;
	stack?: string;
	details?: string[];
}

/** 索引任务的简要统计（成功/失败数量）。 */
export interface IndexSummary {
	total: number;
	failed: number;
}

export type RebuildIndexStage = "preparing" | "indexing" | "saving" | "success" | "error";

/**
 * 重建索引的进度事件。
 *
 * Settings UI 会用它更新进度条与状态文案；某些阶段还会携带更多细节（当前文件、失败数等）。
 */
export interface RebuildIndexProgress {
	stage: RebuildIndexStage;
	message: string;
	done?: number;
	total?: number;
	percent?: number;
	file?: string;
	failed?: number;
	indexedNotes?: number;
}

/** 存储统计里单个文件的占比信息。 */
export interface IndexStoragePartSummary {
	label: string;
	path: string;
	bytes: number;
	share: number;
}

/** 索引快照的磁盘占用统计（用于设置页的“存储统计”）。 */
export interface IndexStorageSummary {
	noteCount: number;
	chunkCount: number;
	vectorCount: number;
	noteVectorCount: number;
	chunkVectorCount: number;
	embeddingDimension: number;
	snapshotFormat: "missing" | "json-only" | "json+binary";
	parts: IndexStoragePartSummary[];
	totalBytes: number;
}

/** 默认设置：作为 `loadSettings()` 的兜底来源。 */
export const DEFAULT_SETTINGS: SemanticConnectionsSettings = {
	maxConnections: 20,
	minSimilarityScore: 0.25,
	maxPassagesPerNote: 5,
	excludedFolders: [],
	embeddingProvider: "remote",
	autoIndex: false,
	autoOpenConnectionsView: true,
	lastFullRebuildAt: 0,
	remoteBaseUrl: "",
	remoteApiKey: "",
	remoteModel: "BAAI/bge-m3",
	remoteTimeoutMs: 30_000,
	remoteBatchSize: 16,
};

/**
 * 插件全局类型定义
 *
 * 定义 note、chunk、搜索结果等核心数据结构，
 * 所有模块共享这些类型以保证一致性。
 */

/** 向量类型：固定长度的浮点数组 */
export type Vector = number[];

/** 本地模型量化精度，对应 Transformers.js 的 ONNX 文件变体 */
export type LocalDtype = "fp32" | "fp16" | "q8" | "q4";

/**
 * Note 元数据
 * 代表 vault 中一篇 Markdown 文件的索引信息
 */
export interface NoteMeta {
	/** 文件在 vault 中的相对路径（唯一标识） */
	path: string;
	/** 笔记标题（通常取文件名或首行标题） */
	title: string;
	/** 文件最后修改时间戳（ms） */
	mtime: number;
	/** 文件内容 hash，用于判断是否需要重新索引 */
	hash: string;
	/** 笔记中的标签列表 */
	tags: string[];
	/** 笔记中的出链路径列表 */
	outgoingLinks: string[];
	/** 笔记摘要文本（用于生成 note-level embedding） */
	summaryText: string;
	/** note-level 向量（可选，用于粗筛） */
	vector?: Vector;
}

/**
 * Chunk 元数据
 * 代表一篇笔记中的一个语义块（标题块或段落块）
 */
export interface ChunkMeta {
	/** chunk 唯一标识：`${notePath}#${order}` */
	chunkId: string;
	/** 所属笔记路径 */
	notePath: string;
	/** chunk 所在的标题（若有） */
	heading: string;
	/** chunk 原始文本内容 */
	text: string;
	/** chunk 在笔记中的顺序（从 0 开始） */
	order: number;
	/** chunk-level 向量 */
	vector?: Vector;
}

/**
 * 连接结果项
 * 表示一条与当前笔记相关的推荐结果
 */
export interface ConnectionResult {
	/** 相关笔记路径 */
	notePath: string;
	/** 笔记标题 */
	title: string;
	/** note-level 相似度分数 */
	score: number;
	/** 最佳匹配段落（passage） */
	bestPassage: PassageResult;
}

/**
 * 段落匹配结果
 * 从候选笔记中选出的最契合段落
 */
export interface PassageResult {
	/** 段落所属的 chunkId */
	chunkId: string;
	/** 段落所在标题 */
	heading: string;
	/** 段落文本内容 */
	text: string;
	/** chunk-level 相似度分数 */
	score: number;
}

/**
 * Lookup 搜索结果项
 * 语义搜索返回的单条结果
 */
export interface LookupResult {
	/** 笔记路径 */
	notePath: string;
	/** 笔记标题 */
	title: string;
	/** 匹配的最佳段落 */
	passage: PassageResult;
	/** 综合相关度分数 */
	score: number;
}

/**
 * 插件设置
 */
export interface SemanticConnectionsSettings {
	/** 每次展示的最大相关笔记数 */
	maxConnections: number;
	/** 排除的文件夹路径列表 */
	excludedFolders: string[];
	/** embedding provider 类型 */
	embeddingProvider: "mock" | "local" | "remote";
	/** 自动索引是否开启 */
	autoIndex: boolean;

	// ---- Remote Provider 配置 ----
	/** API Key（OpenAI 或兼容服务） */
	remoteApiKey: string;
	/**
	 * API Base URL
	 * 默认 OpenAI，也可配置为兼容服务（Azure、together.ai 等）
	 */
	remoteApiUrl: string;
	/** Embedding 模型名称 */
	remoteModel: string;
	/** 单次批量请求最大条数（避免超过 API 限制） */
	remoteBatchSize: number;

	// ---- Local Provider 配置 ----
	/** 本地模型 ID（如 "Xenova/bge-base-zh-v1.5"） */
	localModelId: string;
	/** 本地模型量化精度（默认 q8，平衡大小与精度） */
	localDtype: LocalDtype;
}

/**
 * 索引错误日志条目
 * 记录单次索引失败的详细信息，用于事后诊断
 */
export interface IndexErrorEntry {
	/** 错误发生时间（ms since epoch） */
	timestamp: number;
	/** 失败的文件路径 */
	filePath: string;
	/** 错误类型分类 */
	errorType: "embedding" | "scanning" | "chunking" | "storage" | "unknown";
	/** 错误详细信息 */
	message: string;
	/** 使用的 embedding provider */
	provider?: string;
}

/**
 * 全量索引的执行摘要
 * 由 ReindexService.indexAll() 返回，用于 UI 显示索引结果
 */
export interface IndexSummary {
	/** 扫描到的文件总数 */
	total: number;
	/** 索引失败的文件数 */
	failed: number;
}

/**
 * 远程 API 返回的模型信息
 * 用于设置页的模型下拉选择框
 */
export interface RemoteModelInfo {
	/** 模型 ID（如 "text-embedding-3-small"） */
	id: string;
	/** 模型所有者（如 "openai"、"system"） */
	ownedBy: string;
}

/** 插件默认设置 */
export const DEFAULT_SETTINGS: SemanticConnectionsSettings = {
	maxConnections: 20,
	excludedFolders: [],
	embeddingProvider: "mock",
	autoIndex: true,
	remoteApiKey: "",
	remoteApiUrl: "https://api.openai.com/v1",
	remoteModel: "text-embedding-3-small",
	remoteBatchSize: 100,
	localModelId: "Xenova/bge-base-zh-v1.5",
	localDtype: "q8",
};

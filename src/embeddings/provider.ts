import type { Vector } from "../types";

/**
 * EmbeddingProvider - embeddings 提供方接口。
 *
 * 该接口刻意保持最小化：只描述“把文本变成向量”的能力。
 *
 * 约定：
 * - `dimension` 表示向量维度；某些 provider 可能在第一次请求后才能确定维度
 * - `embedBatch()` 应当保持输出顺序与输入 texts 一致（非常重要：ReindexService 依赖它做 chunk->vector 对齐）
 * - `prepare()`/`dispose()` 为可选生命周期钩子（例如建立连接、释放资源、清理缓存等）
 */
export interface EmbeddingProvider {
	readonly name: string;
	readonly dimension: number;

	/** 对单段文本生成 embedding 向量。 */
	embed(text: string): Promise<Vector>;
	/** 批量生成 embedding 向量（输出顺序必须与输入 texts 对齐）。 */
	embedBatch(texts: string[]): Promise<Vector[]>;
	/** 可选：提前准备资源，并可返回已知的 dimension（如果可用）。 */
	prepare?(): Promise<number>;
	/** 可选：释放资源（插件卸载或切换 provider 时调用）。 */
	dispose?(): Promise<void>;
}

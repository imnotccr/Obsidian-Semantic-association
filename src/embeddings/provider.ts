/**
 * EmbeddingProvider - 向量生成接口（策略模式的抽象策略）
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                      │
 * │  被谁实现：MockProvider、RemoteProvider                          │
 * │  被谁依赖：EmbeddingService（通过此接口操作具体 provider）        │
 * │  参见：ARCHITECTURE.md「四、Embedding 层」                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 这是 Embedding 层的核心接口，定义了「文本 → 向量」的统一契约。
 * 所有具体的 embedding 实现都必须实现此接口。
 *
 * ## 设计模式：策略模式（Strategy Pattern）
 *
 * ```
 * EmbeddingService（Context，上下文）
 *   └─ 持有 EmbeddingProvider 引用（Strategy，策略接口）
 *        ├─ MockProvider（ConcreteStrategy A）
 *        └─ RemoteProvider（ConcreteStrategy B）
 * ```
 *
 * 调用方（ReindexService、LookupService）只依赖 EmbeddingService，
 * EmbeddingService 内部通过此接口调用具体 provider。
 * 切换 provider 时，调用方代码无需改动（OCP 原则）。
 *
 * ## 接口设计原则
 *
 * ### ISP（接口隔离原则）
 * 接口只包含 embedding 生成所需的最小方法集：
 * - name：标识 provider（用于日志、调试）
 * - dimension：向量维度（VectorStore 需要知道维度来验证一致性）
 * - embed：单条文本 → 单个向量
 * - embedBatch：多条文本 → 多个向量（批量优化）
 *
 * 不包含任何与生命周期、配置、持久化相关的方法。
 *
 * ### DIP（依赖倒置原则）
 * ReindexService 不直接 import MockProvider 或 RemoteProvider，
 * 而是通过 EmbeddingService → EmbeddingProvider 接口间接使用。
 * 这样新增 provider（如 LocalProvider）时，只需：
 * 1. 实现此接口
 * 2. 在 EmbeddingService.createProvider() 中添加一个 case
 *
 * ## 两个方法的区别
 *
 * | 方法       | 使用场景                        | 调用方                    |
 * |-----------|-------------------------------|--------------------------|
 * | embed     | 生成 note-level 向量（单条）     | ReindexService 步骤 6    |
 * |           | 生成查询向量（LookupService）    | LookupService.search()   |
 * | embedBatch| 生成 chunk-level 向量（多条）    | ReindexService 步骤 5    |
 *
 * embedBatch 的价值：
 * - MockProvider：直接循环调用 embed，无差异
 * - RemoteProvider：一次 API 请求发送多条文本，
 *   减少网络往返次数，大幅提升批量索引效率
 */

import type { Vector } from "../types";

export interface EmbeddingProvider {
	/**
	 * Provider 名称标识
	 *
	 * 用于：
	 * - 日志输出时区分来源（如 "mock"、"remote"）
	 * - EmbeddingService 记录当前使用的 provider
	 */
	readonly name: string;

	/**
	 * 输出向量的维度
	 *
	 * - MockProvider：128（固定）
	 * - RemoteProvider：取决于模型（text-embedding-3-small = 1536）
	 *
	 * VectorStore 使用此值初始化维度，并验证后续写入向量的一致性。
	 * 如果 provider 切换导致维度变化，需要重建全部索引。
	 */
	readonly dimension: number;

	/**
	 * 为单条文本生成 embedding 向量
	 *
	 * 使用场景：
	 * 1. ReindexService.indexFile() 步骤 6：为 noteMeta.summaryText 生成 note-level 向量
	 * 2. LookupService.search()：为用户输入的搜索关键词生成查询向量
	 *
	 * @param text - 输入文本（自然语言）
	 * @returns 归一化的浮点数组（长度 = dimension）
	 */
	embed(text: string): Promise<Vector>;

	/**
	 * 为多条文本批量生成 embedding 向量
	 *
	 * 使用场景：
	 * ReindexService.indexFile() 步骤 5：为一篇笔记的所有 chunks 批量生成向量
	 *
	 * 为什么不直接循环调用 embed？
	 * - MockProvider：效果一样（内部就是循环）
	 * - RemoteProvider：一次 HTTP 请求发送多条文本（batch API），
	 *   比逐条请求减少 (N-1) 次网络往返，在索引 1000 篇笔记时差距巨大
	 *
	 * @param texts - 输入文本数组
	 * @returns 向量数组，与输入文本一一对应（顺序严格匹配）
	 */
	embedBatch(texts: string[]): Promise<Vector[]>;
}

/**
 * VectorStore - 向量存储与检索
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Storage Layer（存储层）                            │
 * │  被谁调用：                                                         │
 * │    写入：ReindexService（索引时写入 note/chunk 向量）                │
 * │    读取：ConnectionsService（note-level 粗筛）                      │
 * │         LookupService（chunk-level 搜索）                           │
 * │         PassageSelector（获取候选 chunk 向量做比较）                 │
 * │  参见：ARCHITECTURE.md「三、核心数据结构 → VectorStore」             │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 负责存储所有向量数据，并提供最近邻搜索能力。
 * 是整个语义检索系统的数学核心。
 *
 * ## 存储设计
 *
 * 使用单一 Map<id, Vector> 统一存储两种类型的向量：
 *
 * | id 格式              | 类型              | 示例                        |
 * |----------------------|-------------------|-----------------------------|
 * | notePath（不含 #）   | note-level 向量   | "notes/Python基础.md"       |
 * | notePath#order       | chunk-level 向量  | "notes/Python基础.md#0"     |
 *
 * 为什么混合存储？
 * - 简化实现：一个 Map 一套 API
 * - 通过 filterFn 在搜索时区分类型（id.includes('#') 判断是否为 chunk）
 * - 避免维护两个 Store 的同步问题
 *
 * ## 搜索算法
 *
 * v1 采用暴力遍历（brute-force）+ 余弦相似度：
 * - 时间复杂度：O(n)，n = 向量总数
 * - 空间复杂度：O(n)
 * - 适用范围：向量数 < 10 万时性能可接受（~50ms）
 *
 * 后续优化方向：
 * - 当向量数超过 10 万时，可替换为 HNSW 等 ANN 索引
 * - 搜索接口（search 方法签名）保持不变，调用方无需修改
 *
 * ## 余弦相似度
 *
 * 公式：cos(A, B) = (A · B) / (|A| × |B|)
 * - 值域：[-1, 1]
 * - 1 = 方向完全相同（最相似）
 * - 0 = 正交（不相关）
 * - -1 = 方向完全相反
 *
 * 选择余弦相似度而非欧氏距离的原因：
 * - embedding 向量通常已归一化，余弦相似度等价于点积
 * - 不受向量长度影响，只关注方向（语义方向）
 * - 业界主流 embedding 模型的推荐度量方式
 */

import type { Vector } from "../types";

/**
 * 持久化数据格式
 *
 * 向量数据量较大（1000 篇笔记 × 5 chunks × 1536 维 ≈ 30MB JSON），
 * 后续可考虑二进制格式（如 Float32Array + ArrayBuffer）减少磁盘占用。
 */
interface VectorStoreData {
	version: number;
	vectors: Record<string, number[]>;
	/** 向量维度，所有向量必须一致 */
	dimension: number;
}

const CURRENT_VERSION = 1;

/** 搜索结果项：id + 相似度分数 */
export interface VectorSearchResult {
	id: string;
	score: number;
}

export class VectorStore {
	/**
	 * 向量存储：id → Vector
	 *
	 * id 的两种格式：
	 * - "notes/xxx.md" = note-level 向量
	 * - "notes/xxx.md#2" = chunk-level 向量（第 3 个 chunk）
	 */
	private vectors: Map<string, Vector> = new Map();

	/**
	 * 当前向量维度
	 *
	 * 由第一条写入的向量决定。所有后续写入的向量维度必须一致。
	 * MockProvider = 128 维，OpenAI text-embedding-3-small = 1536 维。
	 */
	private dimension: number = 0;

	/**
	 * 从持久化数据恢复
	 *
	 * 插件启动时调用，恢复上次保存的所有向量。
	 * 这样只有新增/修改的文件需要重新计算 embedding。
	 */
	load(raw: unknown): void {
		this.vectors.clear();
		this.dimension = 0;

		if (!raw || typeof raw !== "object") return;

		const data = raw as VectorStoreData;
		if (data.version !== CURRENT_VERSION || !data.vectors) return;

		this.dimension = data.dimension || 0;
		for (const [id, vec] of Object.entries(data.vectors)) {
			this.vectors.set(id, vec);
		}
	}

	/** 导出为可持久化对象 */
	serialize(): VectorStoreData {
		const vectors: Record<string, number[]> = {};
		for (const [id, vec] of this.vectors) {
			vectors[id] = vec;
		}
		return { version: CURRENT_VERSION, vectors, dimension: this.dimension };
	}

	/**
	 * 写入一条向量
	 *
	 * 首次写入时自动确定维度。后续写入的向量维度应与首次一致，
	 * 否则余弦相似度计算会返回 0（维度不匹配时的保护逻辑）。
	 */
	set(id: string, vector: Vector): void {
		if (this.dimension === 0) {
			this.dimension = vector.length;
		}
		this.vectors.set(id, vector);
	}

	/** 批量写入（减少方法调用开销） */
	setBatch(entries: Array<{ id: string; vector: Vector }>): void {
		for (const { id, vector } of entries) {
			this.set(id, vector);
		}
	}

	/** 获取单条向量（用于 PassageSelector 取某个 chunk 的向量） */
	get(id: string): Vector | undefined {
		return this.vectors.get(id);
	}

	/** 删除单条向量 */
	delete(id: string): boolean {
		return this.vectors.delete(id);
	}

	/**
	 * 按前缀批量删除
	 *
	 * 使用场景：删除某篇笔记时，需要删除其所有 chunk 向量。
	 * 例如 deleteByPrefix("notes/Python基础.md#") 会删除：
	 *   - "notes/Python基础.md#0"
	 *   - "notes/Python基础.md#1"
	 *   - "notes/Python基础.md#2"
	 *   ...
	 *
	 * 注意：不会删除 "notes/Python基础.md"（note-level 向量），
	 * 因为它不以 "#" 结尾的前缀开头。调用方需要单独删除。
	 */
	deleteByPrefix(prefix: string): void {
		// 先收集所有匹配的 key，避免在遍历过程中修改 Map
		for (const id of Array.from(this.vectors.keys())) {
			if (id.startsWith(prefix)) {
				this.vectors.delete(id);
			}
		}
	}

	/**
	 * 处理文件重命名：将旧前缀的向量迁移到新前缀
	 *
	 * 例如文件从 "old/path.md" 重命名为 "new/path.md"：
	 * - "old/path.md"   → "new/path.md"      （note-level 向量）
	 * - "old/path.md#0" → "new/path.md#0"     （chunk 向量）
	 * - "old/path.md#1" → "new/path.md#1"     （chunk 向量）
	 *
	 * 实现策略：先收集所有需要迁移的条目，再批量执行。
	 * 不能边遍历边修改 Map，否则会导致迭代器失效。
	 */
	rename(oldPrefix: string, newPrefix: string): void {
		const toMigrate: Array<{ oldId: string; newId: string; vector: Vector }> = [];

		// 第一轮：收集需要迁移的条目
		for (const [id, vec] of this.vectors) {
			if (id.startsWith(oldPrefix)) {
				// 保留前缀之后的部分（如 "#0"、"#1"，或空字符串）
				const suffix = id.slice(oldPrefix.length);
				toMigrate.push({ oldId: id, newId: newPrefix + suffix, vector: vec });
			}
		}

		// 第二轮：执行迁移
		for (const { oldId, newId, vector } of toMigrate) {
			this.vectors.delete(oldId);
			this.vectors.set(newId, vector);
		}
	}

	/**
	 * 最近邻搜索（暴力遍历）
	 *
	 * 这是整个语义检索系统的底层搜索引擎。
	 * 遍历所有向量，计算与查询向量的余弦相似度，返回 topK 结果。
	 *
	 * @param query    - 查询向量（当前笔记的 note 向量 / 用户输入的 query 向量）
	 * @param topK     - 返回最相似的 K 条结果
	 * @param filterFn - 过滤函数，返回 true 表示该 id 参与搜索
	 *
	 * filterFn 的典型用法：
	 * - ConnectionsService: (id) => id !== currentPath && !id.includes('#')
	 *   含义：只搜索 note-level 向量，排除自身
	 * - LookupService: (id) => id.includes('#')
	 *   含义：只搜索 chunk-level 向量
	 *
	 * @returns 按相似度降序排列的结果数组
	 *
	 * 性能说明：
	 * - 1000 篇笔记 × 5 chunks = 5000 向量 × 1536 维 → 搜索耗时约 5-10ms
	 * - 10000 篇笔记 × 5 chunks = 50000 向量 → 搜索耗时约 50-100ms
	 * - 超过 10 万向量时建议升级为 ANN 索引
	 */
	search(
		query: Vector,
		topK: number,
		filterFn?: (id: string) => boolean,
	): VectorSearchResult[] {
		const results: VectorSearchResult[] = [];

		for (const [id, vec] of this.vectors) {
			// 应用过滤条件
			if (filterFn && !filterFn(id)) continue;

			const score = this.cosineSimilarity(query, vec);
			results.push({ id, score });
		}

		// 全量排序后取 topK
		// 优化空间：可用 min-heap 将复杂度从 O(n log n) 降到 O(n log K)
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	}

	/** 当前存储的向量数量 */
	get size(): number {
		return this.vectors.size;
	}

	/** 清空所有向量（全量重建前调用） */
	clear(): void {
		this.vectors.clear();
		this.dimension = 0;
	}

	/**
	 * 余弦相似度计算
	 *
	 * 公式推导：
	 *   cos(A, B) = (A · B) / (|A| × |B|)
	 *             = Σ(Ai × Bi) / (√Σ(Ai²) × √Σ(Bi²))
	 *
	 * 实现细节：
	 * - 单次遍历同时计算点积和两个向量的范数，避免多次遍历
	 * - 维度不匹配时返回 0（安全降级，不抛异常）
	 * - 零向量时返回 0（避免除以零）
	 *
	 * @returns 相似度值，范围 [-1, 1]，越大越相似
	 */
	private cosineSimilarity(a: Vector, b: Vector): number {
		if (a.length !== b.length) return 0;

		let dotProduct = 0;  // A · B（点积）
		let normA = 0;       // |A|²（A 的范数的平方）
		let normB = 0;       // |B|²（B 的范数的平方）

		// 单次遍历计算三个值
		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}

		// 分母 = |A| × |B|
		const denominator = Math.sqrt(normA) * Math.sqrt(normB);

		// 零向量保护：避免 0/0 = NaN
		if (denominator === 0) return 0;

		return dotProduct / denominator;
	}
}

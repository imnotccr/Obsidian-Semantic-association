/**
 * MockProvider - 开发测试用的 Mock Embedding Provider
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                      │
 * │  实现接口：EmbeddingProvider                                     │
 * │  被谁使用：EmbeddingService（当 settings.embeddingProvider = "mock"）│
 * │  参见：ARCHITECTURE.md「四、Embedding 层」                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 在不依赖任何外部 API 的情况下，跑通整个索引和搜索流程。
 * 适用于：
 * - 开发调试：验证 Scanner→Chunker→Embedding→Store 流程是否正确
 * - 单元测试：无网络依赖，可离线运行
 * - 功能演示：让用户在未配置 API Key 时也能体验插件功能
 *
 * ## 伪向量生成算法
 *
 * 使用「字符频率统计」生成固定 128 维的向量：
 *
 * ```
 * 输入文本 "hello"
 *   → 统计每个字符的 charCode
 *   → 对 128 取模，得到槽位
 *   → 累加到对应槽位
 *   → L2 归一化
 *   → 输出 128 维向量
 * ```
 *
 * ### 关键特性
 *
 * 1. **确定性**：同一文本始终产生相同向量（不含随机成分）
 *    - 这保证了 hash 比对跳过后向量仍然一致
 *    - 也方便单元测试断言
 *
 * 2. **近似语义**：字符分布相似的文本会产生相似的向量
 *    - "Python 编程" 和 "Python 入门" 的字符频率有较大重叠
 *    - 虽然不是真正的语义理解，但足以验证搜索排序逻辑
 *
 * 3. **归一化**：输出向量经过 L2 归一化（长度 = 1）
 *    - 这样 VectorStore 的余弦相似度计算等价于简单的点积
 *    - 与真实 embedding 模型的输出格式一致
 *
 * ## 与 RemoteProvider 的对比
 *
 * | 特性         | MockProvider      | RemoteProvider       |
 * |-------------|-------------------|----------------------|
 * | 向量维度      | 128               | 1536（可变）          |
 * | 语义质量      | 伪语义（字符级）    | 真语义（transformer） |
 * | 网络依赖      | 无                | 需要 API 访问         |
 * | 费用          | 免费              | 按 token 计费         |
 * | 速度          | 极快（纯计算）     | 取决于网络延迟         |
 * | 适用场景      | 开发/测试          | 生产使用              |
 */

import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";

/**
 * Mock 向量维度
 *
 * 选择 128 的原因：
 * - 足够小：内存开销低，存储空间小，适合开发环境
 * - 足够大：128 个槽位能区分不同字符分布的文本
 * - 2 的幂次：对齐友好，取模运算高效
 *
 * 注意：这个维度与 RemoteProvider 的维度（1536）不同。
 * 如果用户从 mock 切换到 remote，需要重建全部索引，
 * 因为 VectorStore 中的旧向量维度不匹配。
 */
const MOCK_DIMENSION = 128;

export class MockProvider implements EmbeddingProvider {
	readonly name = "mock";
	readonly dimension = MOCK_DIMENSION;

	/**
	 * 为单条文本生成伪向量
	 *
	 * 虽然是 async 方法（接口要求），但实际是同步计算，
	 * 返回立即 resolve 的 Promise。这使得 mock 模式下
	 * 索引速度极快，不受网络延迟影响。
	 */
	async embed(text: string): Promise<Vector> {
		return this.generateVector(text);
	}

	/**
	 * 批量生成伪向量
	 *
	 * 与 RemoteProvider 不同，这里没有批量优化的必要。
	 * 每条文本的向量生成是独立的纯计算，无网络 IO，
	 * 直接 map 循环调用即可。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		return texts.map((text) => this.generateVector(text));
	}

	/**
	 * 基于字符频率生成伪向量
	 *
	 * 算法步骤：
	 *
	 * ### 步骤 1：初始化零向量
	 * 创建长度为 128 的全零数组。
	 *
	 * ### 步骤 2：字符频率映射
	 * 遍历文本中每个字符：
	 * ```
	 * charCode = 字符的 Unicode 码点
	 * slot = charCode % 128        // 映射到 [0, 127] 的槽位
	 * vector[slot] += 1            // 累加该槽位的计数
	 * ```
	 *
	 * 例如 'h' 的 charCode = 104，映射到 slot 104（104 % 128 = 104）
	 * 如果文本中有 3 个 'h'，则 vector[104] = 3
	 *
	 * 不同字符可能映射到同一槽位（哈希冲突），但这对伪语义来说可以接受。
	 *
	 * ### 步骤 3：L2 归一化
	 * ```
	 * norm = √(Σ vector[i]²)
	 * vector[i] = vector[i] / norm
	 * ```
	 * 归一化后向量长度 = 1，使得余弦相似度 = 点积。
	 * 这与真实 embedding 模型的输出保持一致。
	 *
	 * @param text - 输入文本
	 * @returns 128 维归一化向量
	 */
	private generateVector(text: string): Vector {
		const vector = new Array<number>(MOCK_DIMENSION).fill(0);

		// 空文本返回零向量（VectorStore 的 cosineSimilarity 会返回 0）
		if (!text || text.length === 0) return vector;

		// 步骤 2：统计字符频率并映射到向量槽位
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			const slot = code % MOCK_DIMENSION;
			vector[slot] += 1;
		}

		// 步骤 3：L2 归一化——使向量长度为 1
		// norm = ||v|| = √(v₁² + v₂² + ... + v₁₂₈²)
		const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
		if (norm > 0) {
			for (let i = 0; i < vector.length; i++) {
				vector[i] /= norm;
			}
		}

		return vector;
	}
}

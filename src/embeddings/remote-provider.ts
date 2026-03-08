/**
 * RemoteProvider - 远程 API Embedding Provider
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                          │
 * │  实现接口：EmbeddingProvider                                         │
 * │  被谁使用：EmbeddingService（当 settings.embeddingProvider = "remote"）│
 * │  参见：ARCHITECTURE.md「四、Embedding 层」                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 通过 OpenAI 兼容的 /v1/embeddings 接口生成真实语义向量。
 * 这是生产环境中推荐使用的 provider。
 *
 * ## 兼容的 API 服务
 *
 * 任何符合 OpenAI Embedding API 规范的服务都可以接入：
 * - OpenAI 原生 API（api.openai.com）
 * - Azure OpenAI Service
 * - together.ai、Fireworks.ai 等第三方托管
 * - 本地部署的兼容服务（如 LocalAI、llama.cpp）
 *
 * 用户只需在设置中配置 Base URL 和 API Key 即可。
 *
 * ## API 调用流程
 *
 * ```
 * embed(text) / embedBatch(texts)
 *   → callApi(inputs)           // 核心调用方法
 *     → 清理输入（空文本 → " "）
 *     → POST /v1/embeddings     // 使用 Obsidian requestUrl（绕过 CORS）
 *       {
 *         input: ["text1", "text2", ...],
 *         model: "text-embedding-3-small"
 *       }
 *     → 解析响应，按 index 排序
 *     → 动态更新维度
 *     → 返回 Vector[]
 * ```
 *
 * ## 三个关键机制
 *
 * ### 1. 批量分片（Batch Splitting）
 *
 * OpenAI API 单次请求最多接受一定数量的文本。
 * embedBatch 按 batchSize 将大数组切分为多个小批次：
 *
 * ```
 * 假设 batchSize = 20，共 55 条文本：
 *   批次 1：texts[0..19]   → callApi → vectors[0..19]
 *   批次 2：texts[20..39]  → callApi → vectors[20..39]
 *   批次 3：texts[40..54]  → callApi → vectors[40..54]
 * ```
 *
 * ### 2. 自动重试（Retry with Backoff）
 *
 * 遇到以下 HTTP 状态码时自动重试（指数退避）：
 * - 429 Too Many Requests：API 速率限制
 * - 5xx Server Error：服务端临时故障
 *
 * ```
 * 重试时间线（指数退避）：
 * attempt 0：立即请求
 * attempt 1（失败）→ 等待 1000ms → 重试
 * attempt 2（失败）→ 等待 2000ms → 重试
 * attempt 3（失败）→ 抛出最终错误
 * ```
 *
 * 其他错误码（如 401 Unauthorized、400 Bad Request）不重试，直接抛出。
 *
 * ### 3. 动态维度检测
 *
 * 不同模型输出不同维度的向量：
 * - text-embedding-3-small：1536 维
 * - text-embedding-3-large：3072 维
 * - text-embedding-ada-002：1536 维
 *
 * RemoteProvider 在首次收到 API 响应后动态更新 dimension 属性，
 * 而非硬编码维度值。这样用户切换模型时无需修改配置。
 *
 * ## 为什么使用 requestUrl 而非 fetch
 *
 * Obsidian 桌面端使用 Electron，其中 fetch API 受 CORS 限制。
 * Obsidian 提供的 requestUrl 内部使用 Node.js 的 http/https 模块，
 * 绕过了浏览器的 CORS 策略，可以直接请求任意 API 端点。
 */

import { requestUrl } from "obsidian";
import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";

/**
 * Remote Provider 配置
 *
 * 这些值来自用户在 Settings Tab 中的设置：
 * - apiKey：API 密钥（如 OpenAI 的 sk-xxx）
 * - apiUrl：API Base URL（如 https://api.openai.com/v1）
 * - model：模型名称（如 text-embedding-3-small）
 * - batchSize：单次 API 请求最大文本数（推荐 20）
 */
export interface RemoteProviderConfig {
	apiKey: string;
	apiUrl: string;
	model: string;
	batchSize: number;
}

/**
 * OpenAI Embedding API 响应格式
 *
 * 标准响应示例：
 * ```json
 * {
 *   "data": [
 *     { "embedding": [0.1, -0.2, ...], "index": 0 },
 *     { "embedding": [0.3,  0.1, ...], "index": 1 }
 *   ],
 *   "usage": { "prompt_tokens": 42, "total_tokens": 42 }
 * }
 * ```
 *
 * 注意 index 字段：API 可能不按输入顺序返回结果，
 * 需要按 index 排序后才能与输入文本一一对应。
 */
interface EmbeddingResponse {
	data: Array<{
		embedding: number[];
		index: number;
	}>;
	usage?: {
		prompt_tokens: number;
		total_tokens: number;
	};
}

/**
 * 最大重试次数
 *
 * 3 次是一个常见的工程实践值：
 * - 太少（1 次）：偶发的 429/5xx 就会失败
 * - 太多（10 次）：用户等待时间过长
 * - 3 次 + 指数退避 ≈ 最多等待 1 + 2 + 4 = 7 秒
 */
const MAX_RETRIES = 3;

/**
 * 初始重试等待时间（ms）
 *
 * 指数退避的基数。实际等待时间 = INITIAL_RETRY_DELAY × 2^attempt：
 * - attempt 0 → 1000ms
 * - attempt 1 → 2000ms
 * - attempt 2 → 4000ms
 */
const INITIAL_RETRY_DELAY = 1000;

export class RemoteProvider implements EmbeddingProvider {
	readonly name = "remote";

	/**
	 * 向量维度（动态检测）
	 *
	 * 初始值 1536 是 text-embedding-3-small 的默认维度。
	 * 在首次成功调用 API 后，会根据实际返回的向量长度更新。
	 *
	 * 为什么不在构造函数中查询维度？
	 * - 构造函数是同步的，不能调用 async API
	 * - 延迟检测避免了不必要的 API 调用（如果用户还没开始索引）
	 */
	private _dimension: number = 1536;

	/**
	 * @param config - 远程 API 配置
	 * @throws 如果 apiKey 为空则抛出错误（没有 Key 无法调用 API）
	 */
	constructor(private config: RemoteProviderConfig) {
		if (!config.apiKey) {
			throw new Error("Remote Embedding Provider: API Key is required");
		}
	}

	get dimension(): number {
		return this._dimension;
	}

	/**
	 * 为单条文本生成 embedding
	 *
	 * 内部仍然调用 callApi（数组形式），只是传入长度为 1 的数组。
	 * 这样共享同一套重试和错误处理逻辑。
	 *
	 * 使用场景：
	 * - ReindexService 步骤 6：生成 note-level 向量
	 * - LookupService.search()：生成用户查询的向量
	 */
	async embed(text: string): Promise<Vector> {
		const results = await this.callApi([text]);
		return results[0];
	}

	/**
	 * 批量生成 embedding
	 *
	 * 自动按 batchSize 分片请求，避免超过 API 单次请求的输入限制。
	 *
	 * 为什么需要分片？
	 * - OpenAI API 对单次请求的 token 总数和输入数量有限制
	 * - batchSize = 20 是一个安全的默认值
	 * - 一篇笔记通常有 3~10 个 chunks，一次请求就够
	 *
	 * 分片策略：
	 * ```
	 * texts = [t0, t1, t2, ..., t54]  // 55 条
	 * batchSize = 20
	 *
	 * 循环：
	 * i=0:  batchTexts = [t0..t19]   → callApi → 写入 allResults[0..19]
	 * i=20: batchTexts = [t20..t39]  → callApi → 写入 allResults[20..39]
	 * i=40: batchTexts = [t40..t54]  → callApi → 写入 allResults[40..54]
	 * ```
	 *
	 * 注意：分片请求是串行的（不是并行），因为并行请求更容易触发 429。
	 *
	 * @param texts - 输入文本数组
	 * @returns 向量数组，索引与输入一一对应
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) return [];

		const batchSize = this.config.batchSize;
		const allResults: Vector[] = new Array(texts.length);

		// 按 batchSize 分片，逐批请求
		for (let i = 0; i < texts.length; i += batchSize) {
			const batchTexts = texts.slice(i, i + batchSize);
			const batchResults = await this.callApi(batchTexts);

			// 将本批结果写入 allResults 的对应位置
			for (let j = 0; j < batchResults.length; j++) {
				allResults[i + j] = batchResults[j];
			}
		}

		return allResults;
	}

	/**
	 * 调用 OpenAI 兼容的 Embedding API（核心方法）
	 *
	 * 这是与外部 API 交互的唯一入口点。所有 embed/embedBatch
	 * 最终都通过此方法发送 HTTP 请求。
	 *
	 * 请求格式（OpenAI 标准）：
	 * ```
	 * POST {apiUrl}/embeddings
	 * Headers:
	 *   Content-Type: application/json
	 *   Authorization: Bearer sk-xxxxx
	 * Body:
	 *   { "input": ["text1", "text2"], "model": "text-embedding-3-small" }
	 * ```
	 *
	 * 响应处理：
	 * 1. 检查 data 数组是否非空
	 * 2. 按 index 字段排序（API 不保证返回顺序）
	 * 3. 提取 embedding 数组
	 * 4. 更新 dimension（首次调用时）
	 *
	 * @param inputs - 输入文本数组（已分片，长度 ≤ batchSize）
	 * @returns 向量数组，顺序与 inputs 严格一致
	 * @throws 重试耗尽或遇到不可重试错误时抛出
	 */
	private async callApi(inputs: string[]): Promise<Vector[]> {
		// 预处理：清理空文本
		// OpenAI API 不接受空字符串作为输入，会返回 400 错误。
		// 将空文本替换为单个空格，生成的向量虽然无意义，但不会中断流程。
		const cleanedInputs = inputs.map((t) => t.trim() || " ");

		// 构建请求 URL：baseUrl + /embeddings
		// 用户配置的 apiUrl 通常是 "https://api.openai.com/v1"
		// 拼接后变为 "https://api.openai.com/v1/embeddings"
		const url = `${this.config.apiUrl}/embeddings`;
		const body = {
			input: cleanedInputs,
			model: this.config.model,
		};

		let lastError: Error | null = null;

		// ── 带指数退避的重试循环 ──
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				// 使用 Obsidian 的 requestUrl 发送请求
				// 它基于 Node.js http 模块，不受浏览器 CORS 限制
				const response = await requestUrl({
					url,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Authorization": `Bearer ${this.config.apiKey}`,
					},
					body: JSON.stringify(body),
				});

				const data = response.json as EmbeddingResponse;

				// 验证响应完整性
				if (!data.data || data.data.length === 0) {
					throw new Error("API returned empty embedding data");
				}

				// 按 index 排序
				// OpenAI 文档未保证返回顺序与输入顺序一致，
				// 实际测试中通常是有序的，但为安全起见排序处理
				const sorted = data.data.sort((a, b) => a.index - b.index);
				const vectors = sorted.map((item) => item.embedding);

				// 动态更新维度：从实际返回的向量长度推断
				if (vectors.length > 0) {
					this._dimension = vectors[0].length;
				}

				return vectors;
			} catch (err) {
				lastError = err as Error;
				const statusCode = this.extractStatusCode(err);

				// 429（Rate Limit）或 5xx（Server Error）：可重试
				// 这些是临时性错误，重试通常能成功
				if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
					// 指数退避：1000ms → 2000ms → 4000ms
					const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
					console.warn(
						`RemoteProvider: API error ${statusCode}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
					);
					await this.sleep(delay);
					continue; // 重试
				}

				// 其他错误（401 未授权、400 参数错误等）：不重试
				// 这些是永久性错误，重试没有意义
				throw new Error(
					`Remote Embedding API error: ${this.formatError(err)}`,
				);
			}
		}

		// 所有重试都失败
		throw new Error(
			`Remote Embedding API failed after ${MAX_RETRIES} retries: ${this.formatError(lastError)}`,
		);
	}

	/**
	 * 从错误对象中提取 HTTP 状态码
	 *
	 * Obsidian 的 requestUrl 在 HTTP 非 2xx 时抛出的错误对象
	 * 包含 status 属性。如果无法提取到状态码，返回 0
	 * （不会匹配任何重试条件，等效于不重试）。
	 */
	private extractStatusCode(err: unknown): number {
		if (err && typeof err === "object" && "status" in err) {
			return (err as { status: number }).status;
		}
		return 0;
	}

	/** 格式化错误信息用于日志和异常消息 */
	private formatError(err: unknown): string {
		if (err instanceof Error) return err.message;
		return String(err);
	}

	/**
	 * 延迟等待（用于重试退避）
	 *
	 * 返回一个在指定毫秒数后 resolve 的 Promise。
	 * 配合 await 使用实现非阻塞等待。
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

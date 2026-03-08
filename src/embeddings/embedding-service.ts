/**
 * EmbeddingService - Embedding 调度服务（门面 + 工厂）
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                          │
 * │  被谁调用：                                                          │
 * │    - ReindexService（索引时生成 embedding）                           │
 * │    - LookupService（搜索时将查询文本转为向量）                         │
 * │  依赖谁：MockProvider 或 RemoteProvider（通过 EmbeddingProvider 接口）│
 * │  参见：ARCHITECTURE.md「四、Embedding 层」                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 这是上层模块与 Embedding 能力之间的「门面」（Facade）。
 *
 * ## 为什么需要 EmbeddingService
 *
 * 上层模块（ReindexService、LookupService）不应该直接使用 MockProvider
 * 或 RemoteProvider。原因：
 *
 * 1. **解耦**：上层不关心当前用的是哪个 provider
 * 2. **运行时切换**：用户可以在设置中随时切换 provider，
 *    EmbeddingService 的 switchProvider() 方法处理这个切换
 * 3. **统一入口**：所有 embedding 调用都经过这里，方便添加
 *    全局逻辑（如日志、缓存、指标统计）
 *
 * ## 设计模式
 *
 * 结合了两种模式：
 *
 * ### 门面模式（Facade）
 * ```
 * ReindexService → EmbeddingService.embed()
 *                                    ↓
 *                       provider.embed()  ← 内部委托
 * ```
 * 上层只看到简单的 embed/embedBatch 方法，不知道内部是 mock 还是 remote。
 *
 * ### 工厂方法模式（Factory Method）
 * ```
 * createProvider(settings)
 *   → settings.embeddingProvider === "remote" → new RemoteProvider(...)
 *   → settings.embeddingProvider === "mock"   → new MockProvider()
 * ```
 * 根据配置创建对应的 provider 实例。新增 provider 只需添加一个 case。
 *
 * ## 数据流
 *
 * ### 索引阶段（ReindexService → EmbeddingService）
 * ```
 * ReindexService.indexFile()
 *   → step 5: embeddingService.embedBatch(chunkTexts)
 *       → provider.embedBatch(chunkTexts)
 *         → [chunk 向量数组]
 *   → step 6: embeddingService.embed(summaryText)
 *       → provider.embed(summaryText)
 *         → note 向量
 * ```
 *
 * ### 搜索阶段（LookupService → EmbeddingService）
 * ```
 * LookupService.search(queryText)
 *   → embeddingService.embed(queryText)
 *     → provider.embed(queryText)
 *       → 查询向量
 *   → vectorStore.search(查询向量, topK, filterFn)
 * ```
 *
 * ## 生命周期
 *
 * 1. main.ts 的 createServices() 中创建 EmbeddingService
 * 2. 首次创建时根据 settings 实例化对应的 provider
 * 3. 用户在 Settings Tab 中切换 provider 时，
 *    main.ts 调用 switchProvider() 重新创建 provider
 * 4. 切换 provider 后需要重建索引（因为新旧 provider 维度可能不同）
 */

import type { Vector } from "../types";
import type { SemanticConnectionsSettings } from "../types";
import type { EmbeddingProvider } from "./provider";
import { MockProvider } from "./mock-provider";
import { RemoteProvider } from "./remote-provider";

export class EmbeddingService {
	/**
	 * 当前使用的 provider 实例
	 *
	 * 通过 EmbeddingProvider 接口引用，不关心具体类型。
	 * 所有 embed/embedBatch 调用都委托给这个实例。
	 */
	private provider: EmbeddingProvider;

	/**
	 * @param settings - 插件全局设置
	 *
	 * 构造时根据 settings.embeddingProvider 创建对应的 provider。
	 * 保存 settings 引用是为了 switchProvider() 时能访问最新配置。
	 */
	constructor(private settings: SemanticConnectionsSettings) {
		this.provider = this.createProvider(settings);
	}

	/**
	 * 当前使用的 provider 名称
	 *
	 * 返回值：\"mock\" 或 \"remote\"
	 * 用于 UI 显示和日志记录。
	 */
	get providerName(): string {
		return this.provider.name;
	}

	/**
	 * 当前向量维度
	 *
	 * 委托给 provider.dimension。
	 * - MockProvider：始终返回 128
	 * - RemoteProvider：初始 1536，首次 API 调用后动态更新
	 */
	get dimension(): number {
		return this.provider.dimension;
	}

	/**
	 * 为单条文本生成 embedding
	 *
	 * 纯委托方法：直接转发给当前 provider。
	 * 之所以不直接暴露 provider，是为了保持封装性，
	 * 后续可以在此添加缓存、日志等切面逻辑。
	 */
	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	/**
	 * 批量生成 embedding
	 *
	 * 同样是纯委托。批量调用的价值体现在 RemoteProvider 中：
	 * 一次 HTTP 请求发送多条文本，减少网络往返。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	/**
	 * 切换 provider
	 *
	 * 在以下场景调用：
	 * - 用户在 Settings Tab 中从 mock 切换到 remote
	 * - 用户在 Settings Tab 中修改了 remote 的配置（URL、Model、Key）
	 *
	 * main.ts 中的 onSettingsChanged() 会调用此方法：
	 * ```
	 * this.embeddingService.switchProvider(this.settings);
	 * ```
	 *
	 * 注意：切换 provider 后，旧向量与新向量维度可能不同，
	 * 需要用户手动执行「重建索引」命令来重新生成所有向量。
	 */
	switchProvider(settings: SemanticConnectionsSettings): void {
		this.settings = settings;
		this.provider = this.createProvider(settings);
	}

	/**
	 * 根据设置创建对应的 provider 实例（工厂方法）
	 *
	 * 遵循 OCP 原则（开闭原则）：
	 * - 新增 provider 类型时，只需在此处添加一个 case
	 * - 不需要修改 embed/embedBatch 等方法
	 * - 不需要修改 ReindexService、LookupService 等调用方
	 *
	 * 当前支持：
	 * - "remote"：使用 OpenAI 兼容 API（生产推荐）
	 * - "mock"：使用字符频率伪向量（开发调试用）
	 * - default → mock：未知类型时降级到 mock，避免崩溃
	 */
	private createProvider(settings: SemanticConnectionsSettings): EmbeddingProvider {
		switch (settings.embeddingProvider) {
			case "remote":
				return new RemoteProvider({
					apiKey: settings.remoteApiKey,
					apiUrl: settings.remoteApiUrl,
					model: settings.remoteModel,
					batchSize: settings.remoteBatchSize,
				});
			case "mock":
			default:
				// default 降级到 mock：即使 settings 中出现未知值也不会崩溃
				return new MockProvider();
		}
	}
}

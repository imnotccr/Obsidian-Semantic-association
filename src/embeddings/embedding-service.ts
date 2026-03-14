/**
 * EmbeddingService - 向量生成服务（Embedding orchestration）。
 *
 * 在架构中的角色：
 * - 对上：给索引层（ReindexService）和查询层（LookupService）提供统一的 embed 接口
 * - 对下：根据 settings 选择具体的 EmbeddingProvider（目前只有 RemoteProvider）
 *
 * 设计动机：
 * - 把“provider 选择 / 生命周期管理 / 连接测试 / 错误归一化”集中在一个地方
 * - 其它模块只关心：给我文本，我返回向量（Vector）
 */
import type { ErrorDiagnostic, SemanticConnectionsSettings, Vector } from "../types";
import { normalizeErrorDiagnostic } from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";
import { RemoteProvider } from "./remote-provider";

/** EmbeddingService 对外暴露的“失败结果”结构（用于设置页的测试连接）。 */
type ServiceOperationFailure = {
	ok: false;
	error: string;
	diagnostic: ErrorDiagnostic;
};

/** EmbeddingService 对外暴露的“成功结果”结构（泛型承载额外字段）。 */
type ServiceOperationSuccess<T> = { ok: true } & T;

/**
 * EmbeddingService：根据配置创建 provider，并提供 embed / embedBatch 能力。
 *
 * 注意：
 * - `EmbeddingProvider` 可能持有网络连接/缓存等资源，因此需要 `dispose()`（如果实现了）
 * - 当 settings 变化时（例如 baseUrl/model/timeout/batch），调用 `switchProvider()` 切换 provider
 */
export class EmbeddingService {
	private provider: EmbeddingProvider;

	constructor(private settings: SemanticConnectionsSettings) {
		this.provider = this.createProvider(settings);
	}

	/** 当前 provider 的标识名（用于日志/诊断展示）。 */
	get providerName(): string {
		return this.provider.name;
	}

	/** 当前 provider 的向量维度（首次请求后通常会被 RemoteProvider 推断出来）。 */
	get dimension(): number {
		return this.provider.dimension;
	}

	/** 对单段文本生成 embedding 向量。 */
	async embed(text: string): Promise<Vector> {
		return this.provider.embed(text);
	}

	/**
	 * 批量生成 embedding 向量。
	 *
	 * 说明：远程 provider 通常支持一次请求发送多条 input（batch），效率更高且更易控流。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		return this.provider.embedBatch(texts);
	}

	/**
	 * 切换 provider（或用新 settings 重新创建 provider）。
	 *
	 * 典型场景：用户在设置页修改 remoteBaseUrl / apiKey / model / timeout / batchSize。
	 */
	switchProvider(settings: SemanticConnectionsSettings): void {
		if (this.provider.dispose) {
			void this.provider.dispose();
		}

		this.settings = settings;
		this.provider = this.createProvider(settings);
	}

	/**
	 * 主动释放当前 provider（如果实现了 dispose）。
	 *
	 * 在插件卸载时（onunload）调用，确保不会遗留资源。
	 */
	async disposeCurrentProvider(): Promise<void> {
		if (this.provider.dispose) {
			await this.provider.dispose();
		}
	}

	/**
	 * 测试当前 embeddings 配置是否可用（设置页“测试连接”按钮调用）。
	 *
	 * 实现策略：发送一条极短的真实 embed 请求；
	 * - 成功：返回向量维度
	 * - 失败：返回归一化后的错误信息（ErrorDiagnostic）
	 */
	async testConnection(): Promise<
		ServiceOperationSuccess<{ dimension: number }> | ServiceOperationFailure
	> {
		try {
			const vec = await this.provider.embed("connection test");
			return { ok: true, dimension: vec.length };
		} catch (err) {
			return this.buildFailureResult(err);
		}
	}

	/** 把 unknown error 标准化成 ServiceOperationFailure（用于 UI 展示与日志记录）。 */
	private buildFailureResult(error: unknown): ServiceOperationFailure {
		const diagnostic = normalizeErrorDiagnostic(error);
		return {
			ok: false,
			error: diagnostic.message,
			diagnostic,
		};
	}

	/** 构造 RemoteProvider（OpenAI-compatible / v1/embeddings 形状）。 */
	private createRemoteProvider(settings: SemanticConnectionsSettings): RemoteProvider {
		return new RemoteProvider({
			baseUrl: settings.remoteBaseUrl,
			apiKey: settings.remoteApiKey,
			model: settings.remoteModel,
			timeoutMs: settings.remoteTimeoutMs,
			batchSize: settings.remoteBatchSize,
		});
	}

	/**
	 * 根据 settings 选择 provider。
	 *
	 * 目前 settings.embeddingProvider 只有 "remote"；
	 * 如果未来增加本地模型/不同后端，只需要在这里扩展分支即可。
	 */
	private createProvider(settings: SemanticConnectionsSettings): EmbeddingProvider {
		return this.createRemoteProvider(settings);
	}
}

/**
 * RemoteProvider - 远程 embeddings provider（通过网络请求生成向量）。
 *
 * 该 provider 采用“OpenAI 风格”的 embeddings 接口约定：
 * - Endpoint：`POST {baseUrl}/v1/embeddings`
 * - Body：`{ model: string, input: string[] }`
 * - Response：`{ data: [{ embedding: number[] }, ...] }`
 *
 * 在 Obsidian 插件里不建议直接使用 fetch；这里使用 Obsidian 提供的 `requestUrl()`，
 * 以获得更一致的跨平台行为（桌面端/移动端）与更好的错误信息。
 *
 * 本文件重点关注“健壮性”：
 * - 配置校验（baseUrl/apiKey/model/timeout/batchSize）
 * - 请求超时与网络错误归一化
 * - 响应格式校验（data 数量、embedding 是否为有限数值、维度是否一致）
 * - 维度锁定：同一个 provider 实例一旦确定 dimension，后续请求若维度变化会直接报错
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { Vector } from "../types";
import {
	createErrorFromDiagnostic,
	mergeErrorDetails,
	normalizeErrorDiagnostic,
} from "../utils/error-utils";
import type { EmbeddingProvider } from "./provider";

/**
 * RemoteProvider 初始化配置（来自用户 settings）。
 *
 * 其中 timeoutMs/batchSize 提供默认值（见构造函数）。
 */
export interface RemoteProviderConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutMs?: number;
	batchSize?: number;
}

type RemoteEmbeddingItem = {
	embedding?: unknown;
};

type RemoteEmbeddingResponse = {
	data?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * 规范化用户输入的 baseUrl：
 * - 去空白
 * - 如果用户粘贴了完整的 `/v1/embeddings` 或 `/v1`，会自动裁剪回 base
 * - 去掉多余的尾部 `/`
 *
 * 这样用户既可以填：
 * - `https://api.example.com`
 * - `https://api.example.com/`
 * - `https://api.example.com/v1`
 * - `https://api.example.com/v1/embeddings`
 * 都能得到一致的请求地址。
 */
export const normalizeRemoteBaseUrl = (baseUrl: string): string => {
	const trimmed = baseUrl.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const url = new URL(trimmed);
		let pathname = url.pathname
			.replace(/\/v1\/embeddings\/?$/i, "")
			.replace(/\/v1\/?$/i, "")
			.replace(/\/+$/, "");
		url.pathname = pathname.length > 0 ? pathname : "/";
		return url.toString().replace(/\/$/, "");
	} catch {
		return trimmed;
	}
};

/**
 * RemoteProvider 实现了 EmbeddingProvider 接口：
 * - `embed()`：单条文本
 * - `embedBatch()`：批量文本（内部按 batchSize 分片，多次请求累加）
 *
 * 注意：`dimension` 初始为 0；首次成功请求后由响应向量长度推断并锁定。
 */
export class RemoteProvider implements EmbeddingProvider {
	readonly name = "remote";

	private _dimension = 0;
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly timeoutMs: number;
	private readonly batchSize: number;

	constructor(config: RemoteProviderConfig) {
		this.baseUrl = config.baseUrl;
		this.apiKey = config.apiKey;
		this.model = config.model;
		this.timeoutMs = config.timeoutMs ?? 30_000;
		this.batchSize = config.batchSize ?? 16;
	}

	get dimension(): number {
		return this._dimension;
	}

	/**
	 * 对单段文本生成 embedding 向量。
	 *
	 * 实现上复用 `embedBatch()`，以确保单条/批量走同一套校验与错误处理逻辑。
	 */
	async embed(text: string): Promise<Vector> {
		const vectors = await this.embedBatch([text]);
		if (vectors.length === 0) {
			throw this.createDiagnosticError("Remote embeddings API returned no vectors.", {
				code: "ERR_REMOTE_EMBEDDING_EMPTY",
				stage: "embed-response",
			});
		}
		return vectors[0];
	}

	/**
	 * 批量生成 embedding 向量。
	 *
	 * 重点约定：返回的 vectors 顺序必须与输入 texts 顺序一致。
	 * 索引层会用“同下标”把 chunkText 与 chunkVector 对齐。
	 *
	 * 实现策略：按 batchSize 分片，多次请求并把结果顺序拼接回来。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) {
			return [];
		}

		const batchSize = this.getValidatedBatchSize();
		const vectors: Vector[] = [];

		for (let start = 0; start < texts.length; start += batchSize) {
			const chunk = texts.slice(start, start + batchSize);
			const chunkVectors = await this.requestEmbeddings(chunk);
			vectors.push(...chunkVectors);
		}

		return vectors;
	}

	/**
	 * 对一组 inputs 发送一次 embeddings 请求，并返回对应向量。
	 *
	 * 处理流程：
	 * 1) 构造 endpoint（baseUrl + /v1/embeddings）
	 * 2) sendRequest：发送 HTTP 请求（含超时）
	 * 3) 非 2xx：构造带 code/stage/details 的错误
	 * 4) 解析 JSON、校验 data 数量与 embedding 形状
	 * 5) 推断并锁定 dimension
	 */
	private async requestEmbeddings(inputs: string[]): Promise<Vector[]> {
		const endpoint = this.getEmbeddingsEndpoint();
		const response = await this.sendRequest(endpoint, inputs);

		if (response.status < 200 || response.status >= 300) {
			throw this.buildHttpError(endpoint, response, inputs.length);
		}

		const payload = this.parseSuccessResponse(response, endpoint, inputs.length);
		const vectors = this.extractVectors(payload, inputs.length, endpoint);
		this.applyDimension(vectors[0].length, endpoint);
		return vectors;
	}

	/**
	 * 发送 HTTP 请求（POST JSON）。
	 *
	 * 注意：`requestUrl({ throw: false })` 表示：
	 * - 无论 HTTP status 是否为 2xx，都返回 response（我们自己判断 status）
	 * - 网络层错误仍会 throw（例如 DNS/连接失败），因此需要 catch 并包装成诊断错误
	 */
	private async sendRequest(
		endpoint: string,
		inputs: string[],
	): Promise<RequestUrlResponse> {
		const timeoutMs = this.getValidatedTimeoutMs();
		const requestPromise = requestUrl({
			url: endpoint,
			method: "POST",
			contentType: "application/json",
			headers: {
				Authorization: `Bearer ${this.getRequiredApiKey()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.getRequiredModel(),
				input: inputs,
			}),
			throw: false,
		});

		try {
			return await this.withTimeout(requestPromise, timeoutMs, endpoint, inputs.length);
		} catch (error) {
			const diagnostic = normalizeErrorDiagnostic(error);
			if (diagnostic.code === "ERR_REMOTE_REQUEST_TIMEOUT") {
				throw error;
			}

			throw this.decorateError(error, {
				code: "ERR_REMOTE_REQUEST_NETWORK",
				stage: "request-send",
				details: [`url=${endpoint}`, `input_count=${inputs.length}`],
			});
		}
	}

	/**
	 * 解析成功响应（HTTP 2xx）为 JSON。
	 *
	 * 这里仍然可能失败：例如 response body 为空、或返回了非 JSON 文本。
	 * 失败时会抛出带 code/stage/details 的诊断错误，便于日志记录与用户排查。
	 */
	private parseSuccessResponse(
		response: RequestUrlResponse,
		endpoint: string,
		inputCount: number,
	): RemoteEmbeddingResponse {
		const text = response.text?.trim() ?? "";
		if (!text) {
			throw this.createDiagnosticError("Remote embeddings API returned an empty response body.", {
				code: "ERR_REMOTE_RESPONSE_JSON",
				stage: "response-json",
				details: [`status=${response.status}`, `url=${endpoint}`, `input_count=${inputCount}`],
			});
		}

		try {
			return JSON.parse(text) as RemoteEmbeddingResponse;
		} catch (error) {
			throw this.decorateError(error, {
				code: "ERR_REMOTE_RESPONSE_JSON",
				stage: "response-json",
				details: [
					`status=${response.status}`,
					`url=${endpoint}`,
					`input_count=${inputCount}`,
				],
			});
		}
	}

	/**
	 * 从响应 payload 中抽取向量数组，并做严格校验：
	 * - payload.data 必须是数组
	 * - data.length 必须与输入数量一致（保持对齐）
	 * - 每个 item.embedding 必须是 number[] 且值有限（finite）
	 * - 同一批次内所有向量维度必须一致
	 */
	private extractVectors(
		payload: RemoteEmbeddingResponse,
		expectedCount: number,
		endpoint: string,
	): Vector[] {
		if (!Array.isArray(payload.data)) {
			throw this.createDiagnosticError(
				"Remote embeddings API response is missing a data array.",
				{
					code: "ERR_REMOTE_RESPONSE_DATA",
					stage: "response-data",
					details: [`url=${endpoint}`, `expected_count=${expectedCount}`],
				},
			);
		}

		if (payload.data.length !== expectedCount) {
			throw this.createDiagnosticError(
				`Remote embeddings API returned ${payload.data.length} embeddings for ${expectedCount} inputs.`,
				{
					code: "ERR_REMOTE_RESPONSE_DATA_COUNT",
					stage: "response-data",
					details: [
						`url=${endpoint}`,
						`expected_count=${expectedCount}`,
						`received_count=${payload.data.length}`,
					],
				},
			);
		}

		const vectors = payload.data.map((item, index) =>
			this.parseEmbeddingItem(item as RemoteEmbeddingItem, index, endpoint),
		);

		if (vectors.length === 0) {
			throw this.createDiagnosticError("Remote embeddings API returned no embeddings.", {
				code: "ERR_REMOTE_EMBEDDING_EMPTY",
				stage: "response-embedding",
				details: [`url=${endpoint}`, `expected_count=${expectedCount}`],
			});
		}

		const batchDimension = vectors[0].length;
		for (let index = 1; index < vectors.length; index++) {
			if (vectors[index].length !== batchDimension) {
				throw this.createDiagnosticError(
					`Remote embeddings API returned inconsistent vector dimensions in one batch.`,
					{
						code: "ERR_REMOTE_EMBEDDING_DIMENSION",
						stage: "response-dimension",
						details: [
							`url=${endpoint}`,
							`expected_dimension=${batchDimension}`,
							`received_dimension=${vectors[index].length}`,
							`item_index=${index}`,
						],
					},
				);
			}
		}

		return vectors;
	}

	/**
	 * 解析单条 embeddings item。
	 *
	 * 远程接口的数据结构可能不完全可信，因此这里做尽可能严格的检查，
	 * 以避免把无效向量写入 VectorStore（会导致相似度计算 NaN/崩溃）。
	 */
	private parseEmbeddingItem(
		item: RemoteEmbeddingItem,
		index: number,
		endpoint: string,
	): Vector {
		if (!isRecord(item) || !Array.isArray(item.embedding) || item.embedding.length === 0) {
			throw this.createDiagnosticError(
				`Remote embeddings API response item ${index} has no embedding vector.`,
				{
					code: "ERR_REMOTE_EMBEDDING_MISSING",
					stage: "response-embedding",
					details: [`url=${endpoint}`, `item_index=${index}`],
				},
			);
		}

		if (
			item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
		) {
			throw this.createDiagnosticError(
				`Remote embeddings API response item ${index} contains non-finite values.`,
				{
					code: "ERR_REMOTE_EMBEDDING_INVALID",
					stage: "response-embedding",
					details: [`url=${endpoint}`, `item_index=${index}`],
				},
			);
		}

		return item.embedding.map((value) => Number(value));
	}

	/**
	 * 维度锁定逻辑：
	 * - 首次成功请求：设置 `_dimension`
	 * - 后续请求：如果维度发生变化，直接报错
	 *
	 * 这样可以及时发现“模型被切换/服务端配置变化”等问题，避免索引里混入不同维度的向量。
	 */
	private applyDimension(nextDimension: number, endpoint: string): void {
		if (!Number.isInteger(nextDimension) || nextDimension <= 0) {
			throw this.createDiagnosticError("Remote embeddings API returned an invalid vector size.", {
				code: "ERR_REMOTE_EMBEDDING_DIMENSION",
				stage: "response-dimension",
				details: [`url=${endpoint}`, `received_dimension=${nextDimension}`],
			});
		}

		// bge-m3 dense vectors are commonly 1024 dims, but the plugin trusts the actual API response.
		if (this._dimension === 0) {
			this._dimension = nextDimension;
			return;
		}

		if (this._dimension !== nextDimension) {
			throw this.createDiagnosticError(
				`Remote embeddings dimension changed from ${this._dimension} to ${nextDimension}.`,
				{
					code: "ERR_REMOTE_EMBEDDING_DIMENSION",
					stage: "response-dimension",
					details: [
						`expected_dimension=${this._dimension}`,
						`received_dimension=${nextDimension}`,
						`url=${endpoint}`,
					],
				},
			);
		}
	}

	/**
	 * 构造一个“HTTP status 非 2xx”的诊断错误。
	 *
	 * 会尽量从 response body 中提取可读的错误消息（JSON 或纯文本），
	 * 并附带 status/url/input_count 这类关键排查信息。
	 */
	private buildHttpError(
		endpoint: string,
		response: RequestUrlResponse,
		inputCount: number,
	): Error {
		const responseText = response.text?.trim() ?? "";
		const message = this.extractHttpErrorMessage(response.status, responseText);
		return this.createDiagnosticError(message, {
			code: "ERR_REMOTE_RESPONSE_STATUS",
			stage: "response-status",
			details: [
				`status=${response.status}`,
				`url=${endpoint}`,
				`input_count=${inputCount}`,
			],
		});
	}

	private extractHttpErrorMessage(status: number, responseText: string): string {
		const parsed = this.tryParseJson(responseText);
		if (parsed) {
			const message =
				this.readFirstString(parsed.error) ??
				this.readFirstString(parsed.message) ??
				this.readFirstString(parsed.detail);
			if (message) {
				return `Remote embeddings API request failed with status ${status}: ${message}`;
			}
		}

		if (responseText) {
			return `Remote embeddings API request failed with status ${status}: ${responseText.slice(0, 300)}`;
		}

		return `Remote embeddings API request failed with status ${status}.`;
	}

	private tryParseJson(text: string): Record<string, unknown> | null {
		if (!text) {
			return null;
		}

		try {
			const parsed = JSON.parse(text);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private readFirstString(value: unknown): string | undefined {
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				const nested = this.readFirstString(item);
				if (nested) {
					return nested;
				}
			}
			return undefined;
		}

		if (isRecord(value)) {
			for (const key of ["message", "detail", "type", "code"]) {
				const nested = this.readFirstString(value[key]);
				if (nested) {
					return nested;
				}
			}
		}

		return undefined;
	}

	/**
	 * Promise 超时包装。
	 *
	 * 说明：
	 * - `requestUrl()` 本身没有统一的超时参数（或不同平台行为不一致）
	 * - 这里用 setTimeout 主动 reject 一个诊断错误
	 *
	 * 注意：这不会“取消”底层网络请求，但对调用方来说可以及时返回并记录超时原因。
	 */
	private async withTimeout<T>(
		promise: Promise<T>,
		timeoutMs: number,
		endpoint: string,
		inputCount: number,
	): Promise<T> {
		let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

		return new Promise<T>((resolve, reject) => {
			timer = globalThis.setTimeout(() => {
				reject(
					this.createDiagnosticError(
						`Remote embeddings request timed out after ${timeoutMs}ms.`,
						{
							code: "ERR_REMOTE_REQUEST_TIMEOUT",
							stage: "request-timeout",
							details: [`timeout_ms=${timeoutMs}`, `url=${endpoint}`, `input_count=${inputCount}`],
						},
					),
				);
			}, timeoutMs);

			void promise.then(
				(value) => {
					if (timer !== undefined) {
						globalThis.clearTimeout(timer);
					}
					resolve(value);
				},
				(error) => {
					if (timer !== undefined) {
						globalThis.clearTimeout(timer);
					}
					reject(error);
				},
			);
		});
	}

	/**
	 * 构造 embeddings endpoint：`{baseUrl}/v1/embeddings`。
	 *
	 * 这里会先 normalize baseUrl，并用 URL 解析以确保路径拼接正确。
	 */
	private getEmbeddingsEndpoint(): string {
		const baseUrl = normalizeRemoteBaseUrl(this.getRequiredBaseUrl());
		let url: URL;

		try {
			url = new URL(baseUrl);
		} catch {
			throw this.createDiagnosticError("Remote API Base URL is invalid.", {
				code: "ERR_REMOTE_BASE_URL_INVALID",
				stage: "provider-config",
				details: [`base_url=${baseUrl}`],
			});
		}

		const basePath = url.pathname.replace(/\/+$/, "");
		url.pathname = `${basePath}/v1/embeddings`.replace(/\/{2,}/g, "/");
		return url.toString();
	}

	/** 获取并校验 baseUrl（缺失则抛诊断错误）。 */
	private getRequiredBaseUrl(): string {
		if (!this.baseUrl.trim()) {
			throw this.createDiagnosticError("Remote API Base URL is required.", {
				code: "ERR_REMOTE_BASE_URL_MISSING",
				stage: "provider-config",
			});
		}
		return this.baseUrl.trim();
	}

	/** 获取并校验 apiKey（缺失则抛诊断错误）。 */
	private getRequiredApiKey(): string {
		if (!this.apiKey.trim()) {
			throw this.createDiagnosticError("Remote API Key is required.", {
				code: "ERR_REMOTE_API_KEY_MISSING",
				stage: "provider-config",
			});
		}
		return this.apiKey.trim();
	}

	/** 获取并校验 model（缺失则抛诊断错误）。 */
	private getRequiredModel(): string {
		if (!this.model.trim()) {
			throw this.createDiagnosticError("Remote embedding model is required.", {
				code: "ERR_REMOTE_MODEL_MISSING",
				stage: "provider-config",
			});
		}
		return this.model.trim();
	}

	/** 校验 timeoutMs（必须为正整数）。 */
	private getValidatedTimeoutMs(): number {
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw this.createDiagnosticError("Remote timeout must be a positive integer.", {
				code: "ERR_REMOTE_TIMEOUT_INVALID",
				stage: "provider-config",
				details: [`timeout_ms=${this.timeoutMs}`],
			});
		}
		return this.timeoutMs;
	}

	/** 校验 batchSize（必须为正整数）。 */
	private getValidatedBatchSize(): number {
		if (!Number.isInteger(this.batchSize) || this.batchSize <= 0) {
			throw this.createDiagnosticError("Remote batch size must be a positive integer.", {
				code: "ERR_REMOTE_BATCH_SIZE_INVALID",
				stage: "provider-config",
				details: [`batch_size=${this.batchSize}`],
			});
		}
		return this.batchSize;
	}

	/**
	 * 把未知错误包装成“带诊断信息”的 Error：
	 * - 保留 normalizeErrorDiagnostic 提取出的 message/name/stack/details
	 * - 如果缺失 code/stage，则使用 fallback 提供的值补齐
	 */
	private decorateError(
		error: unknown,
		fallback: {
			code: string;
			stage: string;
			details?: string[];
		},
	): Error {
		const diagnostic = normalizeErrorDiagnostic(error);
		return createErrorFromDiagnostic({
			message: diagnostic.message,
			name: diagnostic.name,
			code: diagnostic.code ?? fallback.code,
			stage: diagnostic.stage ?? fallback.stage,
			stack: diagnostic.stack,
			details: mergeErrorDetails(diagnostic.details, fallback.details),
		});
	}

	/**
	 * 创建一个带 code/stage/details 的 Error。
	 *
	 * 这些扩展字段会被写入 error-log.json，帮助定位失败原因与阶段；
	 * 同时也可用于 “失败任务重试” 的可重试判断（例如 429/网络错误）。
	 */
	private createDiagnosticError(
		message: string,
		diagnostic: {
			code: string;
			stage: string;
			details?: string[];
		},
	): Error {
		return createErrorFromDiagnostic({
			message,
			code: diagnostic.code,
			stage: diagnostic.stage,
			details: diagnostic.details,
		});
	}
}

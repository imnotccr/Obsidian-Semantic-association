/**
 * LocalProvider - 本地 Embedding Provider（基于 Transformers.js）
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Embedding Layer（向量化层）                          │
 * │  实现接口：EmbeddingProvider                                         │
 * │  被谁使用：EmbeddingService（当 settings.embeddingProvider = "local"）│
 * │  参见：ARCHITECTURE.md「七、Embedding Provider」                     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * 使用 Transformers.js（@huggingface/transformers）在本地运行 ONNX 格式
 * 的 Embedding 模型，生成真实语义向量。无需外部 API，完全离线运行。
 *
 * ## 工作原理
 *
 * Transformers.js 将 HuggingFace 模型转换为 ONNX 格式，
 * 通过 ONNX Runtime Web（WASM 后端）在浏览器/Electron 中推理。
 *
 * ```
 * embed(text)
 *   → ensureInitialized()        // 懒加载：首次调用时才加载模型
 *     → import("@huggingface/transformers")  // 动态导入，避免启动时拉入
 *     → pipeline("feature-extraction", modelId)  // 加载 ONNX 模型
 *   → pipeline(text, { pooling: "mean", normalize: true })
 *   → 归一化的浮点向量
 * ```
 *
 * ## 懒初始化
 *
 * 模型不在插件启动时加载，而是在首次 embed() 调用时：
 * 1. 避免插件启动延迟（模型加载约 2-10 秒）
 * 2. 避免不必要的内存占用（用户可能还没开始索引）
 * 3. 首次加载会从 HuggingFace Hub 下载模型文件（约 30-200MB）
 *
 * ## 模型缓存
 *
 * 模型文件下载后缓存在插件数据目录的 `models/` 子目录：
 * ```
 * {vault}/.obsidian/plugins/semantic-connections/models/
 * ```
 * 后续启动直接从本地加载，无需重新下载。
 *
 * ## 预置模型
 *
 * 提供三个经过验证的模型供用户选择：
 * - bge-small-zh-v1.5：中文轻量，512 维，速度快
 * - bge-base-zh-v1.5：中文优化，768 维，推荐使用
 * - bge-large-zh-v1.5：中文高精度，1024 维，模型较大
 */

import type { Vector } from "../types";
import type { EmbeddingProvider } from "./provider";

/**
 * 本地模型信息
 * 用于设置页的模型选择列表
 */
export interface LocalModelInfo {
	/** 模型 ID（HuggingFace 仓库路径） */
	id: string;
	/** 显示名称（设置页 dropdown 中使用） */
	name: string;
	/** 输出向量维度 */
	dimension: number;
	/** 模型描述 */
	description: string;
	/** 各 dtype 对应的 ONNX 文件大小提示 */
	sizeHints: Record<string, string>;
}

/**
 * 预置支持的本地模型列表
 *
 * 这些模型已验证可在 Transformers.js 中正常运行。
 * 用户在设置页从这个列表中选择。
 */
export const SUPPORTED_LOCAL_MODELS: LocalModelInfo[] = [
	{
		id: "Xenova/bge-small-zh-v1.5",
		name: "bge-small-zh-v1.5 (Chinese, 512d)",
		dimension: 512,
		description: "轻量中文模型，速度快，适合快速索引",
		sizeHints: { fp32: "~95MB", fp16: "~48MB", q8: "~24MB", q4: "~52MB" },
	},
	{
		id: "Xenova/bge-base-zh-v1.5",
		name: "bge-base-zh-v1.5 (Chinese, 768d)",
		dimension: 768,
		description: "中文基础模型，平衡精度与速度，推荐使用",
		sizeHints: { fp32: "~407MB", fp16: "~204MB", q8: "~102MB", q4: "~120MB" },
	},
	{
		id: "Xenova/bge-large-zh-v1.5",
		name: "bge-large-zh-v1.5 (Chinese, 1024d)",
		dimension: 1024,
		description: "中文大模型，精度最高，但推理较慢",
		sizeHints: { fp32: "~1.3GB", fp16: "~650MB", q8: "~326MB", q4: "~279MB" },
	},
];

/**
 * LocalProvider 配置
 */
export interface LocalProviderConfig {
	/** 模型 ID，如 "Xenova/bge-base-zh-v1.5" */
	modelId: string;
	/** 预期向量维度（从 SUPPORTED_LOCAL_MODELS 获取） */
	dimension: number;
	/** 模型文件缓存目录的绝对路径 */
	cachePath: string;
	/** 量化精度（默认 "q8"） */
	dtype?: string;
	/** 模型下载/加载进度回调（可选） */
	onProgress?: (progress: LocalModelProgress) => void;
}

/**
 * 模型下载/加载进度信息
 * Transformers.js 的 progress_callback 传递的数据结构
 */
export interface LocalModelProgress {
	/** 状态：download / progress / done / initiate 等 */
	status: string;
	/** 正在处理的文件名（如 "onnx/model.onnx"） */
	file?: string;
	/** 下载进度百分比 0-100 */
	progress?: number;
	/** 已下载字节数 */
	loaded?: number;
	/** 总字节数 */
	total?: number;
}

// Transformers.js pipeline 类型（动态导入，此处仅用于内部类型标注）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FeatureExtractionPipeline = any;

export class LocalProvider implements EmbeddingProvider {
	readonly name = "local";

	/** 预期向量维度（从配置中获取，模型加载后验证） */
	private _dimension: number;

	/** Transformers.js 的 feature-extraction pipeline 实例 */
	private pipeline: FeatureExtractionPipeline | null = null;

	/** 初始化 Promise（防止并发初始化） */
	private initPromise: Promise<void> | null = null;

	/** 模型 ID */
	private modelId: string;

	/** 量化精度 */
	private dtype: string;

	/** 模型缓存路径 */
	private cachePath: string;

	/** 进度回调 */
	private onProgress?: (progress: LocalModelProgress) => void;

	constructor(config: LocalProviderConfig) {
		this.modelId = config.modelId;
		this._dimension = config.dimension;
		this.cachePath = config.cachePath;
		this.dtype = config.dtype ?? "q8";
		this.onProgress = config.onProgress;
	}

	get dimension(): number {
		return this._dimension;
	}

	/**
	 * 为单条文本生成 embedding
	 *
	 * 首次调用会触发模型加载（可能需要下载模型文件）。
	 * 后续调用直接使用已加载的模型进行推理。
	 */
	async embed(text: string): Promise<Vector> {
		await this.ensureInitialized();

		const cleanText = text.trim() || " ";
		const output = await this.pipeline(cleanText, {
			pooling: "mean",
			normalize: true,
		});

		// output.tolist() 返回 [[...]] 形状（batch size = 1）
		const vectors = output.tolist() as number[][];
		return vectors[0];
	}

	/**
	 * 批量生成 embedding
	 *
	 * Transformers.js 的 pipeline 支持传入字符串数组做批量推理。
	 * 但实际上在 WASM 后端中性能提升有限，逐条推理也可接受。
	 * 这里仍使用批量调用以保持接口一致性。
	 */
	async embedBatch(texts: string[]): Promise<Vector[]> {
		if (texts.length === 0) return [];

		await this.ensureInitialized();

		// 逐条推理：Transformers.js 在 WASM 后端的批量推理效果有限，
		// 且逐条推理可避免一次性占用过多内存
		const results: Vector[] = [];
		for (const text of texts) {
			const cleanText = text.trim() || " ";
			const output = await this.pipeline(cleanText, {
				pooling: "mean",
				normalize: true,
			});
			const vectors = output.tolist() as number[][];
			results.push(vectors[0]);
		}
		return results;
	}

	/**
	 * 释放模型资源
	 *
	 * 置空 pipeline 引用，让 GC 回收 ONNX Runtime Session。
	 * 切换 provider 或插件卸载时调用。
	 */
	async dispose(): Promise<void> {
		if (this.pipeline) {
			// Transformers.js pipeline 可能提供 dispose 方法
			if (typeof this.pipeline.dispose === "function") {
				await this.pipeline.dispose();
			}
			this.pipeline = null;
			this.initPromise = null;
		}
	}

	/**
	 * 确保模型已加载（懒初始化）
	 *
	 * 使用 initPromise 防止并发：多个 embed() 同时调用时，
	 * 只有第一个会触发加载，后续调用等待同一个 Promise。
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.pipeline) return;

		if (this.initPromise) {
			await this.initPromise;
			return;
		}

		this.initPromise = this.loadPipeline();
		try {
			await this.initPromise;
		} catch (err) {
			// 初始化失败时重置，允许下次重试
			this.initPromise = null;
			throw err;
		}
	}

	/**
	 * 加载 Transformers.js pipeline
	 *
	 * 1. 动态 import Transformers.js（避免插件启动时就拉入 ~10MB 代码）
	 * 2. 配置缓存目录和环境参数
	 * 3. 创建 feature-extraction pipeline
	 * 4. 首次调用时会从 HuggingFace Hub 下载模型文件
	 */
	private async loadPipeline(): Promise<void> {
		// 在 Obsidian/Electron 环境中强制使用 onnxruntime-web，
		// 避免 Transformers.js 在 "node" 环境下默认走 onnxruntime-node（原生模块不可用）
		

		// 动态导入：只在需要时才加载 Transformers.js
		const transformers = await this.importTransformersWebBackend();

		// 配置 Transformers.js 环境
		const env = transformers.env;
		// 使用版本化缓存目录，避免更新后混用旧模型文件
		env.cacheDir = this.cachePath;
		env.localModelPath = this.cachePath;
		env.allowLocalModels = true;
		env.allowRemoteModels = true;

		// 在 Electron 环境中，优先使用 WASM 后端
		if (env.backends?.onnx?.wasm) {
			env.backends.onnx.wasm.proxy = false;
		}

		this.pipeline = await transformers.pipeline(
			"feature-extraction",
			this.modelId,
			{
				progress_callback: (info: Record<string, unknown>) => {
					this.onProgress?.({
						status: String(info.status ?? ""),
						file: info.file ? String(info.file) : undefined,
						progress: typeof info.progress === "number" ? info.progress : undefined,
						loaded: typeof info.loaded === "number" ? info.loaded : undefined,
						total: typeof info.total === "number" ? info.total : undefined,
					});
				},
				dtype: this.dtype as "fp32" | "fp16" | "q8" | "q4",
				device: "wasm",
			},
		);

		// 验证模型维度（通过一次空推理检测）
		try {
			const testOutput = await this.pipeline(" ", {
				pooling: "mean",
				normalize: true,
			});
			const testVec = (testOutput.tolist() as number[][])[0];
			if (testVec && testVec.length !== this._dimension) {
				console.warn(
					`LocalProvider: 模型实际维度 ${testVec.length} 与预期 ${this._dimension} 不一致，已更新`,
				);
				this._dimension = testVec.length;
			}
		} catch {
			// 验证失败不阻塞（维度可能仍正确）
		}
	}

	/**
	 * Import Transformers.js in \"web\" mode so ONNX uses the wasm backend
	 * in Electron/Obsidian (avoid onnxruntime-node).
	 */
	private async importTransformersWebBackend() {
		const ortSymbol = Symbol.for(\"onnxruntime\");
		const globalAny = globalThis as typeof globalThis & {
			process?: NodeJS.Process;
			[key: symbol]: unknown;
		};

		const hadOrt = Object.prototype.hasOwnProperty.call(globalAny, ortSymbol);
		const previousOrt = hadOrt ? globalAny[ortSymbol] : undefined;

		if (hadOrt) {
			try {
				delete globalAny[ortSymbol];
			} catch {
				globalAny[ortSymbol] = undefined;
			}
		}

		const originalProcess = typeof process !== \"undefined\" ? process : undefined;
		const originalReleaseName = originalProcess?.release?.name;
		let releaseSpoofed = false;
		let processHidden = false;

		try {
			if (originalProcess?.release?.name === \"node\") {
				try {
					originalProcess.release.name = \"electron\";
					releaseSpoofed = true;
				} catch {
					// Fallback: temporarily hide process for module init.
					try {
						globalAny.process = undefined;
						processHidden = true;
					} catch {
						// Ignore if process cannot be hidden.
					}
				}
			}

			// Lazy import: only when local model is needed.
			return await import(\"@huggingface/transformers\");
		} finally {
			if (processHidden) {
				globalAny.process = originalProcess;
			}
			if (releaseSpoofed && originalProcess?.release) {
				try {
					originalProcess.release.name = originalReleaseName;
				} catch {
					// Ignore restore failures.
				}
			}
			if (hadOrt) {
				globalAny[ortSymbol] = previousOrt;
			}
		}
	}
}

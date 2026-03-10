/**
 * ReindexService - 索引编排服务
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Indexing Layer（索引层）                         │
 * │  被谁调用：                                                       │
 * │    - main.ts 直接调用 indexAll()（全量索引）                       │
 * │    - ReindexQueue 通过 executor 调用 processTask()（增量索引）     │
 * │  参见：docs/ARCHITECTURE.md「五、索引流程」                        │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * 这是索引层的「编排者」，串联所有组件完成索引流程：
 *
 * ```
 * Scanner（读取文件）
 *   → Chunker（切分为语义块）
 *     → EmbeddingService（生成向量）
 *       → NoteStore + ChunkStore + VectorStore（存储结果）
 * ```
 *
 * ## 两种索引模式
 *
 * ### 1. 全量索引（indexAll）
 * - 触发时机：首次启动 / 用户手动执行「重建索引」命令
 * - 扫描 vault 中所有 .md 文件，逐个执行 indexFile
 * - 支持进度回调，main.ts 用它来更新 Notice 通知
 *
 * ### 2. 增量索引（processTask）
 * - 触发时机：文件 create/modify/delete/rename 事件
 * - 由 ReindexQueue 调度，一次处理一个文件
 * - 通过 hash 比对跳过内容未变的文件
 *
 * ## indexFile 的 7 个步骤
 *
 * 1. 读取文件内容（Scanner.readContent）
 * 2. 构建 NoteMeta（Scanner.buildNoteMeta）
 * 3. Hash 比对：跳过未变文件（关键优化）
 * 4. 切分为 chunks（Chunker.chunk）
 * 5. 批量生成 chunk embedding（EmbeddingService.embedBatch）
 * 6. 生成 note-level embedding（EmbeddingService.embed）
 * 7. 写入三个 Store（NoteStore + ChunkStore + VectorStore）
 *
 * ## 删除与重命名
 *
 * - 删除：级联清理三个 Store 中的所有关联数据
 * - 重命名：先迁移数据（更新路径/id），再重新索引
 *   重命名后重新索引是因为文件名可能影响标题（影响 NoteMeta.title）
 */

import { TFile, type Vault } from "obsidian";
import type { NoteMeta, ChunkMeta, IndexSummary, IndexErrorEntry, Vector } from "../types";
import { Scanner } from "./scanner";
import { Chunker } from "./chunker";
import { EmbeddingService } from "../embeddings/embedding-service";
import { NoteStore } from "../storage/note-store";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore } from "../storage/vector-store";
import type { IndexTask } from "./reindex-queue";
import type { ErrorLogger } from "../utils/error-logger";
import {
	createErrorFromDiagnostic,
	mergeErrorDetails,
	normalizeErrorDiagnostic,
} from "../utils/error-utils";

const MAX_EMBEDDING_INPUT_LENGTH = 1200;
const MIN_EMBEDDING_TEXT_LENGTH = 50;
const MAX_HEADING_CONTEXT_LENGTH = 200;
const SENTENCE_BOUNDARIES = ".!?;\u3002\uFF01\uFF1F\uFF1B";
const CLAUSE_BOUNDARIES = ",:\uFF0C\u3001\uFF1A";
const ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID = "ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID";
const ERR_INDEX_CHUNK_SPLIT_STALLED = "ERR_INDEX_CHUNK_SPLIT_STALLED";
const ERR_INDEX_CHUNK_SPLIT_EMPTY = "ERR_INDEX_CHUNK_SPLIT_EMPTY";
const ERR_INDEX_CHUNK_PAYLOAD_EMPTY = "ERR_INDEX_CHUNK_PAYLOAD_EMPTY";
const ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG = "ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG";
const ERR_INDEX_CHUNK_EMBED_REQUEST = "ERR_INDEX_CHUNK_EMBED_REQUEST";
const ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH = "ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH";
const ERR_INDEX_NOTE_EMBED_REQUEST = "ERR_INDEX_NOTE_EMBED_REQUEST";

export class ReindexService {
	/**
	 * 构造函数注入所有依赖
	 *
	 * ReindexService 是依赖最多的类，因为它是串联所有组件的编排者。
	 * 所有依赖都通过构造函数注入（DIP 原则），在 main.ts 的
	 * createServices() 中组装。
	 *
	 * errorLogger 是可选依赖：不影响核心索引功能，但提供错误持久化能力。
	 */
	constructor(
		private vault: Vault,
		private scanner: Scanner,
		private chunker: Chunker,
		private embeddingService: EmbeddingService,
		private noteStore: NoteStore,
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
		private errorLogger?: ErrorLogger,
	) {}

	/**
	 * 全量索引：扫描 vault 中所有 Markdown 文件，构建完整索引
	 *
	 * 在以下场景调用：
	 * 1. 插件首次启动（noteStore.size === 0）
	 * 2. 用户手动执行「重建索引」命令
	 *
	 * ## v2 改进：单文件容错
	 *
	 * 之前任何一个文件的索引失败都会中断整个 indexAll 流程。
	 * 现在每个文件独立 try-catch：
	 * - 单文件失败 → 记录到 ErrorLogger + 继续下一个文件
	 * - 不再因一个文件的 API 失败丢掉所有已成功索引的数据
	 *
	 * @param excludedFolders - 排除的文件夹（来自用户设置）
	 * @param onProgress      - 进度回调。main.ts 用它更新 Notice 显示：
	 *                          "正在构建语义索引... (42/100)"
	 * @returns 索引摘要：总数 + 失败数
	 */
	async indexAll(
		excludedFolders: string[],
		onProgress?: (done: number, total: number) => void,
	): Promise<IndexSummary> {
		// Scanner 负责扫描和过滤
		const files = this.scanner.getMarkdownFiles(excludedFolders);
		const total = files.length;
		let failed = 0;
		onProgress?.(0, total);

		// 逐个文件索引（不用 Promise.all 并行，因为 embedding API 有速率限制）
		for (let i = 0; i < files.length; i++) {
			try {
				await this.indexFile(files[i]);
			} catch (err) {
				failed++;
				// 记录到持久化错误日志
				this.errorLogger?.log(
					this.buildErrorLogEntry(files[i].path, err, ["index_mode=full"]),
				);
				console.error(
					`ReindexService: failed to index ${files[i].path}`,
					err,
				);
			}
			// 通知调用方当前进度（无论成功或失败都推进进度条）
			onProgress?.(i + 1, total);
		}

		// 全量索引结束后统一保存错误日志（一次磁盘写入）
		if (failed > 0 && this.errorLogger?.isDirty) {
			await this.errorLogger.save();
		}

		console.log(
			`ReindexService: indexed ${total} files (${failed} failed)`,
		);
		return { total, failed };
	}

	/**
	 * 索引单个文件——完整的 7 步流程
	 *
	 * 这是索引系统的核心方法。无论全量索引还是增量索引，
	 * 最终都会调用这个方法处理单个文件。
	 *
	 * 数据流：
	 * Scanner → hash 检查 → Chunker → EmbeddingService → 三个 Store
	 */
	async indexFile(file: TFile): Promise<void> {
		// ── 步骤 1：读取文件内容 ──
		// 使用 cachedRead 优先走内存缓存，减少磁盘 IO
		const content = await this.scanner.readContent(file);

		// ── 步骤 2：构建 NoteMeta ──
		// 提取 title、tags、links、summary、hash 等元数据
		const noteMeta = this.scanner.buildNoteMeta(file, content);

		// ── 步骤 3：Hash 比对（增量索引的关键优化） ──
		// 如果文件内容的 hash 与上次索引时相同，说明内容没变，跳过。
		// 这在全量索引时非常有用：假设 1000 篇笔记中只有 10 篇改过，
		// 就可以跳过 990 篇的 embedding 计算，节省大量时间和 API 调用。
		const existing = this.noteStore.get(file.path);
		if (existing && existing.hash === noteMeta.hash) {
			return; // 内容未变，跳过后续所有步骤
		}

		// ── 步骤 4：切分为 chunks ──
		// Chunker 按标题切分，返回 ChunkMeta[]（此时 vector 为空）
		const chunks = this.normalizeChunksForEmbedding(
			file.path,
			this.chunker.chunk(file.path, content),
		);

		// ── 步骤 5：批量生成 chunk embedding ──
		// 将所有 chunk 的文本提取出来，一次性发送给 EmbeddingService
		// 批量调用比逐条调用效率高，也能保持 provider 端的统一批处理入口。
		const chunkTexts = chunks.map((c) => this.buildChunkEmbeddingText(c));
		let chunkVectors: Vector[] = [];
		if (chunkTexts.length > 0) {
			try {
				chunkVectors = await this.embeddingService.embedBatch(chunkTexts);
			} catch (error) {
				throw this.decorateDiagnosticError(error, {
					code: ERR_INDEX_CHUNK_EMBED_REQUEST,
					stage: "chunk-embedding-request",
					details: [
						`chunk_count=${chunks.length}`,
						`input_count=${chunkTexts.length}`,
						`max_input_length=${MAX_EMBEDDING_INPUT_LENGTH}`,
					],
				});
			}

			if (chunkVectors.length !== chunkTexts.length) {
				throw this.createDiagnosticError(
					`Chunk embedding vector count mismatch: expected ${chunkTexts.length}, got ${chunkVectors.length}.`,
					{
						code: ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH,
						stage: "chunk-embedding-response",
						details: [
							`chunk_count=${chunks.length}`,
							`input_count=${chunkTexts.length}`,
							`vector_count=${chunkVectors.length}`,
						],
					},
				);
			}
		}

		// ── 步骤 6：生成 note-level embedding ──
		// 使用 summaryText（前 500 字）生成整篇笔记的向量
		// 这个向量用于 ConnectionsService 的第一阶段粗筛
		let noteVector: NoteMeta["vector"] | undefined;
		if (noteMeta.summaryText) {
			try {
				noteVector = await this.embeddingService.embed(noteMeta.summaryText);
			} catch (error) {
				throw this.decorateDiagnosticError(error, {
					code: ERR_INDEX_NOTE_EMBED_REQUEST,
					stage: "note-embedding-request",
					details: [`summary_length=${noteMeta.summaryText.length}`],
				});
			}
		}

		// ── 步骤 7：写入三个 Store ──

		// 7a. 写入 NoteStore（笔记元数据）
		this.noteStore.set(noteMeta);

		// 7b. 写入 ChunkStore（替换该笔记的所有旧 chunks）
		// replaceByNote 会先删除旧的 chunks 再写入新的，保证一致性
		this.chunkStore.replaceByNote(file.path, chunks);

		// 7c. 写入 VectorStore（note 向量 + chunk 向量）
		// 注意：必须在新向量完全生成成功后再删除旧向量，
		// 否则一旦 embedding 失败会导致旧索引也丢失。
		this.vectorStore.delete(file.path);
		this.vectorStore.deleteByPrefix(file.path + "#");

		// note-level 向量：id = 笔记路径（不含 #）
		if (noteVector) {
			this.vectorStore.set(file.path, noteVector);
		}
		// chunk-level 向量：id = chunkId（格式 path#order，含 #）
		for (let i = 0; i < chunks.length; i++) {
			this.vectorStore.set(chunks[i].chunkId, chunkVectors[i]);
		}
	}

	/**
	 * 处理队列中的单个索引任务
	 *
	 * 由 ReindexQueue 的 executor 回调调用。
	 * 根据任务类型分发到对应的处理逻辑。
	 *
	 * 增量索引的错误使用 logAndSave 即时持久化，
	 * 因为增量任务是零散的，没有统一 save 的时机。
	 *
	 * | 任务类型 | 处理逻辑                              |
	 * |----------|---------------------------------------|
	 * | create   | 与 modify 相同，调用 indexFile        |
	 * | modify   | 调用 indexFile（hash 比对会跳过未变）  |
	 * | delete   | 级联清理三个 Store                    |
	 * | rename   | 迁移数据 + 重新索引                   |
	 */
	async processTask(task: IndexTask): Promise<void> {
		try {
			switch (task.type) {
				case "create":
				case "modify": {
					const file = this.vault.getAbstractFileByPath(task.path);
					if (file instanceof TFile) {
						await this.indexFile(file);
					}
					break;
				}
				case "delete": {
					this.removeFile(task.path);
					break;
				}
				case "rename": {
					if (task.oldPath) {
						this.renameFile(task.oldPath, task.path);
						const file = this.vault.getAbstractFileByPath(task.path);
						if (file instanceof TFile) {
							// rename 后必须刷新 NoteMeta：
							// 即使内容 hash 没变，title 也可能因文件名变化而变化。
							const existing = this.noteStore.get(file.path);
							const content = await this.scanner.readContent(file);
							const noteMeta = this.scanner.buildNoteMeta(file, content);

							// 内容未变：只更新元数据，不重新计算 embedding（向量已在 renameFile 里迁移）
							if (existing && existing.hash === noteMeta.hash) {
								this.noteStore.set(noteMeta);
							} else {
								// 内容有变：走完整索引流程（会重建 chunk/embedding/vector）
								await this.indexFile(file);
							}
						}
					}
					break;
				}
			}
		} catch (err) {
			// 增量索引失败：即时持久化错误日志
			if (this.errorLogger) {
				const details = [`index_mode=incremental`, `task_type=${task.type}`];
				if (task.oldPath) {
					details.push(`old_path=${task.oldPath}`);
				}

				await this.errorLogger.logAndSave(
					this.buildErrorLogEntry(task.path, err, details),
				);
			}
			// 重新抛出，让 ReindexQueue 的 flush 也能捕获并打印
			throw err;
		}
	}

	/**
	 * 删除文件的所有索引数据（级联删除）
	 *
	 * 需要清理三个 Store：
	 * 1. NoteStore：删除该笔记的 NoteMeta
	 * 2. ChunkStore：删除该笔记的所有 chunks
	 * 3. VectorStore：删除 note 向量 + 所有 chunk 向量
	 *
	 * VectorStore 需要两次删除：
	 * - delete(path)：删除 note-level 向量（id = "notes/a.md"）
	 * - deleteByPrefix(path + "#")：删除所有 chunk 向量（id = "notes/a.md#0", "#1"...）
	 */
	private buildErrorLogEntry(
		filePath: string,
		err: unknown,
		contextDetails?: string[],
	): Omit<IndexErrorEntry, "timestamp"> {
		const diagnostic = normalizeErrorDiagnostic(err);
		return {
			filePath,
			errorType: this.classifyError(err),
			message: diagnostic.message,
			provider: this.embeddingService.providerName,
			errorName: diagnostic.name,
			errorCode: diagnostic.code,
			stage: diagnostic.stage,
			stack: diagnostic.stack,
			details: mergeErrorDetails(diagnostic.details, contextDetails),
		};
	}

	private buildChunkEmbeddingText(chunk: ChunkMeta): string {
		const heading = this.getHeadingContextForEmbedding(chunk.heading);
		return heading ? `${heading}\n\n${chunk.text}` : chunk.text;
	}

	private normalizeChunksForEmbedding(notePath: string, chunks: ChunkMeta[]): ChunkMeta[] {
		const normalizedChunks: ChunkMeta[] = [];

		for (const chunk of chunks) {
			const maxTextLength = this.getMaxChunkTextLength(chunk.heading);
			const parts = this.splitTextForEmbedding(chunk.text, maxTextLength);
			const sourceText = chunk.text.trim();
			if (sourceText.length > 0 && parts.length === 0) {
				throw this.createDiagnosticError(
					"Chunk normalization produced no valid parts for a non-empty chunk.",
					{
						code: ERR_INDEX_CHUNK_SPLIT_EMPTY,
						stage: "chunk-embedding-split",
						details: [
							`note_path=${notePath}`,
							`source_chunk_id=${chunk.chunkId}`,
							`source_order=${chunk.order}`,
							`text_length=${sourceText.length}`,
							`limit=${maxTextLength}`,
						],
					},
				);
			}

			for (const part of parts) {
				const text = part.trim();
				if (!text) {
					continue;
				}

				const order = normalizedChunks.length;
				const normalizedChunk: ChunkMeta = {
					...chunk,
					chunkId: `${notePath}#${order}`,
					order,
					text,
				};
				const payload = this.buildChunkEmbeddingText(normalizedChunk);
				if (!payload.trim()) {
					throw this.createDiagnosticError(
						"Chunk embedding payload is empty after normalization.",
						{
							code: ERR_INDEX_CHUNK_PAYLOAD_EMPTY,
							stage: "chunk-embedding-validate",
							details: [
								`note_path=${notePath}`,
								`chunk_id=${normalizedChunk.chunkId}`,
								`order=${normalizedChunk.order}`,
								`heading_length=${normalizedChunk.heading.trim().length}`,
								`text_length=${normalizedChunk.text.length}`,
							],
						},
					);
				}
				if (payload.length > MAX_EMBEDDING_INPUT_LENGTH) {
					throw this.createDiagnosticError(
						"Chunk embedding payload still exceeds the max length after normalization.",
						{
							code: ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG,
							stage: "chunk-embedding-validate",
							details: [
								`note_path=${notePath}`,
								`chunk_id=${normalizedChunk.chunkId}`,
								`order=${normalizedChunk.order}`,
								`payload_length=${payload.length}`,
								`max_input_length=${MAX_EMBEDDING_INPUT_LENGTH}`,
								`heading_length=${this.getHeadingContextForEmbedding(normalizedChunk.heading).length}`,
								`text_length=${normalizedChunk.text.length}`,
							],
						},
					);
				}

				normalizedChunks.push(normalizedChunk);
			}
		}

		return normalizedChunks;
	}

	private getHeadingContextForEmbedding(heading: string): string {
		const trimmed = heading.trim();
		if (!trimmed) {
			return "";
		}
		if (trimmed.length <= MAX_HEADING_CONTEXT_LENGTH) {
			return trimmed;
		}
		return `${trimmed.slice(0, MAX_HEADING_CONTEXT_LENGTH).trimEnd()}...`;
	}

	private getMaxChunkTextLength(heading: string): number {
		const headingContext = this.getHeadingContextForEmbedding(heading);
		const headingOverhead = headingContext ? headingContext.length + 2 : 0;
		const limit = Math.max(
			MIN_EMBEDDING_TEXT_LENGTH,
			MAX_EMBEDDING_INPUT_LENGTH - headingOverhead,
		);
		if (!Number.isInteger(limit) || limit <= 0) {
			throw this.createDiagnosticError("Chunk embedding text limit is invalid.", {
				code: ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID,
				stage: "chunk-embedding-limit",
				details: [
					`heading_length=${heading.trim().length}`,
					`heading_context_length=${headingContext.length}`,
					`max_input_length=${MAX_EMBEDDING_INPUT_LENGTH}`,
				],
			});
		}
		return limit;
	}

	private splitTextForEmbedding(text: string, limit: number): string[] {
		const trimmed = text.trim();
		if (!trimmed) {
			return [];
		}
		if (trimmed.length <= limit) {
			return [trimmed];
		}

		const parts: string[] = [];
		let remaining = trimmed;

		while (remaining.length > limit) {
			const splitPoint = this.findSplitPointForEmbedding(remaining, limit);
			if (!Number.isInteger(splitPoint) || splitPoint <= 0 || splitPoint > remaining.length) {
				throw this.createDiagnosticError("Chunk embedding split made no progress.", {
					code: ERR_INDEX_CHUNK_SPLIT_STALLED,
					stage: "chunk-embedding-split",
					details: [`remaining_length=${remaining.length}`, `limit=${limit}`],
				});
			}
			const part = remaining.slice(0, splitPoint).trim();

			if (!part) {
				parts.push(remaining.slice(0, limit).trim());
				remaining = remaining.slice(limit).trimStart();
				continue;
			}

			parts.push(part);
			remaining = remaining.slice(splitPoint).trimStart();
		}

		if (remaining) {
			parts.push(remaining);
		}

		const normalizedParts = parts.filter((part) => part.length > 0);
		if (trimmed.length > 0 && normalizedParts.length === 0) {
			throw this.createDiagnosticError(
				"Chunk embedding split produced no non-empty parts.",
				{
					code: ERR_INDEX_CHUNK_SPLIT_EMPTY,
					stage: "chunk-embedding-split",
					details: [`text_length=${trimmed.length}`, `limit=${limit}`],
				},
			);
		}
		return normalizedParts;
	}

	private findSplitPointForEmbedding(text: string, limit: number): number {
		const softFloor = Math.max(
			MIN_EMBEDDING_TEXT_LENGTH,
			Math.floor(limit * 0.6),
		);
		const preferredBoundaries = ["\n", SENTENCE_BOUNDARIES, CLAUSE_BOUNDARIES, " \t"];

		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, softFloor);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, 0);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		return Math.min(limit, text.length);
	}

	private findLastBoundary(
		text: string,
		limit: number,
		boundaryChars: string,
		floor: number,
	): number {
		const start = Math.min(limit, text.length - 1);
		for (let index = start; index >= floor; index--) {
			if (boundaryChars.includes(text[index])) {
				return index + 1;
			}
		}
		return -1;
	}

	private decorateDiagnosticError(
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

	private removeFile(path: string): void {
		this.noteStore.delete(path);
		this.chunkStore.deleteByNote(path);
		this.vectorStore.delete(path);
		this.vectorStore.deleteByPrefix(path + "#");
	}

	/**
	 * 处理文件重命名的索引迁移
	 *
	 * 将三个 Store 中旧路径的数据迁移到新路径。
	 * 每个 Store 都有 rename 方法来处理各自的数据格式。
	 *
	 * VectorStore.rename(oldPath, newPath) 会迁移：
	 * - "old/path.md" → "new/path.md"
	 * - "old/path.md#0" → "new/path.md#0"
	 * - "old/path.md#1" → "new/path.md#1"
	 * 因为它使用前缀匹配。
	 */
	private renameFile(oldPath: string, newPath: string): void {
		this.noteStore.rename(oldPath, newPath);
		this.chunkStore.rename(oldPath, newPath);
		this.vectorStore.rename(oldPath, newPath);
	}

	/**
	 * 根据错误信息分类错误类型
	 *
	 * 通过关键词匹配对错误进行粗略分类，帮助用户快速定位问题来源：
	 * - embedding: API 调用失败（网络、认证、速率限制等）
	 * - scanning: 文件读取或元数据提取失败
	 * - chunking: 文本切分逻辑异常
	 * - unknown: 无法分类的错误
	 */
	private classifyError(err: unknown): IndexErrorEntry["errorType"] {
		const diagnostic = normalizeErrorDiagnostic(err);
		const lower = diagnostic.message.toLowerCase();
		const code = diagnostic.code?.toLowerCase() ?? "";
		const stage = diagnostic.stage?.toLowerCase() ?? "";

		if (
			code === ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID.toLowerCase() ||
			code === ERR_INDEX_CHUNK_SPLIT_STALLED.toLowerCase() ||
			code === ERR_INDEX_CHUNK_SPLIT_EMPTY.toLowerCase() ||
			code === ERR_INDEX_CHUNK_PAYLOAD_EMPTY.toLowerCase() ||
			code === ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG.toLowerCase() ||
			stage === "chunk-embedding-limit" ||
			stage === "chunk-embedding-split" ||
			stage === "chunk-embedding-validate"
		) {
			return "chunking";
		}
		if (
			code === ERR_INDEX_CHUNK_EMBED_REQUEST.toLowerCase() ||
			code === ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH.toLowerCase() ||
			code === ERR_INDEX_NOTE_EMBED_REQUEST.toLowerCase()
		) {
			return "embedding";
		}

		if (
			lower.includes("embedding") ||
			lower.includes("api") ||
			lower.includes("429") ||
			lower.includes("401") ||
			lower.includes("timeout") ||
			lower.includes("network") ||
			lower.includes("fetch")
		) {
			return "embedding";
		}
		if (
			lower.includes("read") ||
			lower.includes("scan") ||
			lower.includes("content") ||
			lower.includes("file")
		) {
			return "scanning";
		}
		if (lower.includes("chunk") || lower.includes("split")) {
			return "chunking";
		}
		return "unknown";
	}
}

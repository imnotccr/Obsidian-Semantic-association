/**
 * LookupService - 语义搜索服务
 *
 * 职责：
 * - 接收用户输入的自然语言查询
 * - 为查询文本生成 embedding
 * - 在 chunk 级别检索最相关的结果（段落级搜索）
 * - 按笔记聚合结果，每篇笔记附带最佳 passage
 *
 * 搜索策略（段落级语义搜索）：
 * 1. query → embedding
 * 2. 在所有 chunk 向量中检索 topK
 * 3. 按 notePath 聚合，每篇笔记只保留最佳 chunk
 * 4. 排序并返回 LookupResult[]
 */

import type { LookupResult, PassageResult } from "../types";
import { NoteStore } from "../storage/note-store";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore, type VectorSearchResult } from "../storage/vector-store";
import { EmbeddingService } from "../embeddings/embedding-service";

export class LookupService {
	constructor(
		private noteStore: NoteStore,
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
		private embeddingService: EmbeddingService,
	) {}

	/** 判断路径是否属于排除目录（用于搜索结果的实时过滤）。 */
	private isExcludedPath(path: string, excludedFolders: string[]): boolean {
		if (excludedFolders.length === 0) {
			return false;
		}

		return excludedFolders.some((folder) => {
			return path.startsWith(folder + "/") || path === folder;
		});
	}

	/**
	 * 执行语义搜索
	 *
	 * @param query    - 用户输入的查询文本
	 * @param maxResults - 最大返回笔记数
	 * @returns 按相关度降序排列的 LookupResult 列表
	 */
	async search(
		query: string,
		maxResults: number,
		options?: { excludedFolders?: string[] },
	): Promise<LookupResult[]> {
		if (!query.trim()) return [];
		const excludedFolders = options?.excludedFolders ?? [];

		// 1. 为查询文本生成 embedding
		const queryVector = await this.embeddingService.embed(query);

		// 2. 在所有 chunk 向量中检索
		// 只搜索 chunk 向量（id 包含 #），多取一些用于聚合
		const rawResults = this.vectorStore.search(
			queryVector,
			maxResults * 5, // 多取以便聚合
			(id) => id.includes("#"), // 只检索 chunk 级别向量
		);

		if (rawResults.length === 0) return [];

		// 实时过滤：如果结果所属笔记在 excludedFolders 中，则剔除（无需重建索引）。
		// 这样用户只要修改“排除目录”，搜索/关联结果会立刻生效。
		const filteredResults =
			excludedFolders.length === 0
				? rawResults
				: rawResults.filter((result) => {
						const hashIndex = result.id.lastIndexOf("#");
						if (hashIndex === -1) {
							return false;
						}
						const notePath = result.id.substring(0, hashIndex);
						return !this.isExcludedPath(notePath, excludedFolders);
					});

		if (filteredResults.length === 0) {
			return [];
		}

		// 3. 按笔记聚合：每篇笔记只保留最佳 chunk
		const noteMap = this.aggregateByNote(filteredResults);

		// 4. 构建并排序结果
		const results: LookupResult[] = [];

		for (const [notePath, best] of noteMap) {
			if (this.isExcludedPath(notePath, excludedFolders)) {
				continue;
			}

			const noteMeta = this.noteStore.get(notePath);
			if (!noteMeta) continue;

			const chunk = this.chunkStore.get(best.chunkId);
			if (!chunk) continue;

			results.push({
				notePath,
				title: noteMeta.title,
				score: best.score,
				passage: {
					chunkId: best.chunkId,
					heading: chunk.heading,
					text: chunk.text,
					score: best.score,
				},
			});
		}

		// 按分数降序排序
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, maxResults);
	}

	/**
	 * 按笔记路径聚合 chunk 搜索结果
	 * 每篇笔记只保留分数最高的 chunk
	 *
	 * @returns Map<notePath, { chunkId, score }>
	 */
	private aggregateByNote(
		results: VectorSearchResult[],
	): Map<string, { chunkId: string; score: number }> {
		const noteMap = new Map<string, { chunkId: string; score: number }>();

		for (const result of results) {
			// 从 chunkId 中提取 notePath（格式：notePath#order）
			const hashIndex = result.id.lastIndexOf("#");
			if (hashIndex === -1) continue;

			const notePath = result.id.substring(0, hashIndex);

			// 保留每篇笔记中分数最高的 chunk
			const existing = noteMap.get(notePath);
			if (!existing || result.score > existing.score) {
				noteMap.set(notePath, { chunkId: result.id, score: result.score });
			}
		}

		return noteMap;
	}
}

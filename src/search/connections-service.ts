/**
 * ConnectionsService - 当前笔记关联推荐服务
 *
 * 职责：
 * - 为当前打开的笔记找到最相关的其他笔记
 * - 两阶段检索：
 *   1. note-level 召回：用 note 向量粗筛候选笔记
 *   2. chunk-level 精排：在候选笔记中选出最佳 passage
 *
 * 不负责 UI 渲染，只返回结构化的 ConnectionResult[]
 */

import type { ConnectionResult, Vector } from "../types";
import { NoteStore } from "../storage/note-store";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore } from "../storage/vector-store";
import { PassageSelector } from "./passage-selector";

const NOTE_SCORE_WEIGHT = 0.7;
const PASSAGE_SCORE_WEIGHT = 0.3;

export class ConnectionsService {
	private passageSelector: PassageSelector;

	constructor(
		private noteStore: NoteStore,
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
	) {
		this.passageSelector = new PassageSelector(chunkStore, vectorStore);
	}

	/**
	 * 获取与指定笔记最相关的连接结果
	 *
	 * @param notePath       - 当前笔记路径
	 * @param maxConnections - 最大返回数
	 * @returns 按相似度降序排列的 ConnectionResult 列表
	 */
	async findConnections(notePath: string, maxConnections: number): Promise<ConnectionResult[]> {
		if (maxConnections <= 0) return [];

		// 获取当前笔记的 note-level 向量
		const noteVector = this.vectorStore.get(notePath);
		if (!noteVector) return [];

		// 第一阶段：note-level 召回
		// 多取一些候选（2倍），为 chunk 精排留出空间
		const candidateCount = Math.max(maxConnections * 4, maxConnections);
		const candidates = this.vectorStore.search(
			noteVector,
			candidateCount,
			// 排除自身和 chunk 向量（chunk 向量的 id 包含 #）
			(id) => id !== notePath && !id.includes("#"),
		);

		if (candidates.length === 0) return [];

		// 获取当前笔记的所有 chunk 向量（用于 chunk-level 比较）
		const currentChunks = this.chunkStore.getByNote(notePath);
		const currentChunkVectors: Vector[] = currentChunks
			.map((c) => this.vectorStore.get(c.chunkId))
			.filter((v): v is Vector => v !== undefined);

		// 第二阶段：chunk-level 精排 + 选出最佳 passage
		const results: ConnectionResult[] = [];

		for (const candidate of candidates) {
			const candidateMeta = this.noteStore.get(candidate.id);
			if (!candidateMeta) continue;

			// 为每个候选笔记选出最佳 passage
			const bestPassage = this.passageSelector.selectBest(
				candidate.id,
				currentChunkVectors,
			);

			if (!bestPassage) continue;

			const noteScore = candidate.score;
			const passageScore = bestPassage.score;
			const finalScore =
				noteScore * NOTE_SCORE_WEIGHT + passageScore * PASSAGE_SCORE_WEIGHT;

			results.push({
				notePath: candidate.id,
				title: candidateMeta.title,
				score: finalScore,
				noteScore,
				passageScore,
				bestPassage,
			});
		}

		// 按 note-level 分数排序，取前 maxConnections 条
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, maxConnections);
	}
}

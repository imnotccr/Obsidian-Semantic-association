/**
 * ConnectionsService - 当前笔记关联推荐服务
 *
 * 职责：
 * - 为当前打开的笔记找到最相关的其他笔记
 * - 直接在全量 chunk 向量中检索（避免“大笔记 note 向量均值化”导致的语义稀释）
 * - 将命中的 chunks 按笔记聚合，并用 Log-Sum-Exp 聚合成笔记级分数
 *
 * 不负责 UI 渲染，只返回结构化的 ConnectionResult[]
 */

import type { ConnectionResult, PassageResult, Vector } from "../types";
import { NoteStore } from "../storage/note-store";
import { ChunkStore } from "../storage/chunk-store";
import { VectorStore } from "../storage/vector-store";
import { PassageSelector } from "./passage-selector";

/**
 * passage 分数聚合的 beta（LogSumExp 温度系数）。
 *
 * LogSumExp 聚合直觉：
 * - beta 越大：越接近 max（只看最相关段落）
 * - beta 越小：越接近平均（更多段落会“贡献”到笔记级分数）
 *
 * 本插件最终排序目前主要使用 bestPassage.score（更符合 UI 直觉），
 * 但仍保留 passageScore 作为“透明化指标”展示给用户。
 */
const PASSAGE_AGGREGATION_BETA = 10;

export class ConnectionsService {
	private passageSelector: PassageSelector;

	constructor(
		private noteStore: NoteStore,
		private chunkStore: ChunkStore,
		private vectorStore: VectorStore,
	) {
		this.passageSelector = new PassageSelector(this.chunkStore, this.vectorStore);
	}

	private isExcludedPath(path: string, excludedFolders: string[]): boolean {
		if (excludedFolders.length === 0) {
			return false;
		}

		return excludedFolders.some((folder) => {
			return path.startsWith(folder + "/") || path === folder;
		});
	}

	/**
	 * 获取与指定笔记最相关的连接结果
	 *
	 * @param notePath       - 当前笔记路径
	 * @param maxConnections - 最大返回数
	 * @param options        - passage 筛选/截断参数
	 * @returns 按相似度降序排列的 ConnectionResult 列表
	 */
	async findConnections(
		notePath: string,
		maxConnections: number,
		options?: {
			minSimilarityScore?: number;
			/** @deprecated Use `minSimilarityScore` instead. */
			minPassageScore?: number;
			maxPassagesPerNote?: number;
			excludedFolders?: string[];
		},
	): Promise<ConnectionResult[]> {
		if (maxConnections <= 0) {
			return [];
		}

		const legacyMinScore = options?.minPassageScore;
		const minScore =
			typeof options?.minSimilarityScore === "number" && Number.isFinite(options.minSimilarityScore)
				? options.minSimilarityScore
				: typeof legacyMinScore === "number" && Number.isFinite(legacyMinScore)
					? legacyMinScore
					: -Infinity;
		const maxPassagesPerNote = options?.maxPassagesPerNote ?? 0;
		const excludedFolders = options?.excludedFolders ?? [];
		const fallbackCount = Math.min(5, Math.max(0, maxConnections));

		const currentChunks = this.chunkStore.getByNote(notePath);
		const currentChunkVectors: Vector[] = currentChunks
			.map((c) => this.vectorStore.get(c.chunkId))
			.filter((v): v is Vector => v !== undefined);

		// 查询向量：优先使用已持久化的 note-level 向量；缺失时用当前 chunks 的均值兜底。
		let queryVector = this.vectorStore.get(notePath) ?? this.meanVector(currentChunkVectors);

		if (!queryVector) {
			return [];
		}

		// 直接在全量 chunk 向量中检索（chunkId 包含 #）
		const chunkCandidateCount = this.getChunkCandidateCount(maxConnections, maxPassagesPerNote);
		const rawChunkMatches = this.vectorStore.search(
			queryVector,
			chunkCandidateCount,
			(id) => id.includes("#") && !id.startsWith(notePath + "#"),
		);

		if (rawChunkMatches.length === 0) {
			return [];
		}

		// 将命中的 chunks 按 notePath 聚合（用于候选笔记粗筛）
		const seedPassagesByNote = new Map<string, PassageResult[]>();
		const seedBestScoreByNote = new Map<string, number>();

		for (const match of rawChunkMatches) {
			const chunkId = match.id;
			const hashIndex = chunkId.lastIndexOf("#");
			if (hashIndex <= 0) {
				continue;
			}
			const candidateNotePath = chunkId.slice(0, hashIndex);
			if (!candidateNotePath || candidateNotePath === notePath) {
				continue;
			}
			if (this.isExcludedPath(candidateNotePath, excludedFolders)) {
				continue;
			}

			const chunk = this.chunkStore.get(chunkId);
			if (!chunk) {
				continue;
			}

			const passages = seedPassagesByNote.get(candidateNotePath) ?? [];
			passages.push({
				chunkId,
				heading: chunk.heading,
				text: chunk.text,
				score: match.score,
			});
			seedPassagesByNote.set(candidateNotePath, passages);

			const existingSeed = seedBestScoreByNote.get(candidateNotePath);
			if (existingSeed === undefined || match.score > existingSeed) {
				seedBestScoreByNote.set(candidateNotePath, match.score);
			}
		}

		if (seedPassagesByNote.size === 0) {
			return [];
		}

		const candidateNoteLimit = Math.min(
			seedPassagesByNote.size,
			Math.max(30, maxConnections * 5),
		);
		const candidateNotePaths = Array.from(seedBestScoreByNote.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, candidateNoteLimit)
			.map(([path]) => path);

		const results: ConnectionResult[] = [];

		for (const candidateNotePath of candidateNotePaths) {
			if (this.isExcludedPath(candidateNotePath, excludedFolders)) {
				continue;
			}

			const candidateMeta = this.noteStore.get(candidateNotePath);
			if (!candidateMeta) {
				continue;
			}

			const seedPassages = seedPassagesByNote.get(candidateNotePath) ?? [];

			let passages: PassageResult[] = seedPassages;
			if (currentChunkVectors.length > 0) {
				const passageLimit = maxPassagesPerNote > 0 ? maxPassagesPerNote : 20;
				const selected = this.passageSelector.selectMatches(
					candidateNotePath,
					currentChunkVectors,
					{ maxResults: passageLimit },
				);
				if (selected.length > 0) {
					passages = selected;
				}
			}

			passages.sort((a, b) => b.score - a.score);
			const trimmedPassages =
				maxPassagesPerNote > 0 ? passages.slice(0, maxPassagesPerNote) : passages;

			if (trimmedPassages.length === 0) {
				continue;
			}

			const bestPassage = trimmedPassages[0];
			const passageScore = this.aggregatePassageScore(
				trimmedPassages.map((passage) => passage.score),
			);

			// 用“最强关联片段”作为主分数（便于 UI 直觉理解），保留聚合分数用于透明化展示。
			const noteScore = bestPassage.score;
			const finalScore = noteScore;

			results.push({
				notePath: candidateNotePath,
				title: candidateMeta.title,
				score: finalScore,
				noteScore,
				passageScore,
				bestPassage,
				passages: trimmedPassages,
			});
		}

		results.sort((a, b) => b.score - a.score);

		// Threshold is a soft filter: always include the top-N fallback results to avoid an empty UI.
		const output: ConnectionResult[] = [];
		for (const result of results) {
			if (output.length < fallbackCount) {
				output.push(result);
				continue;
			}
			if (output.length >= maxConnections) {
				break;
			}
			if (result.bestPassage.score >= minScore) {
				output.push(result);
			}
		}

		return output;
	}

	private getChunkCandidateCount(maxConnections: number, maxPassagesPerNote: number): number {
		// 候选 chunk 要多取一些：因为后续会按 notePath 聚合并做二次 passage 精排。
		// 经验值：下限 200，或者与 maxConnections/passagesPerNote 成比例。
		const passagesPerNote = maxPassagesPerNote > 0 ? maxPassagesPerNote : 1;
		return Math.max(200, maxConnections * passagesPerNote * 20, maxConnections * 50);
	}

	private meanVector(vectors: Vector[]): Vector | undefined {
		// 当 note-level 向量缺失时，用当前笔记的 chunk 向量均值作为兜底查询向量。
		// 这不是最精确的语义表示，但能在“只索引了 chunk 向量”时仍然工作。
		if (vectors.length === 0) {
			return undefined;
		}

		const dimension = vectors[0].length;
		if (!Number.isInteger(dimension) || dimension <= 0) {
			return undefined;
		}

		const sums = new Array<number>(dimension).fill(0);
		let count = 0;

		for (const vec of vectors) {
			if (vec.length !== dimension) {
				continue;
			}
			for (let i = 0; i < dimension; i++) {
				sums[i] += vec[i];
			}
			count++;
		}

		if (count === 0) {
			return undefined;
		}

		const inv = 1 / count;
		for (let i = 0; i < sums.length; i++) {
			sums[i] *= inv;
		}

		return sums;
	}

	private aggregatePassageScore(scores: number[]): number {
		// 聚合多个 passage 分数（LogSumExp），并把结果裁剪到 [-1, 1]。
		// （cosine similarity 理论范围就是 [-1, 1]）
		if (scores.length === 0) {
			return -Infinity;
		}
		if (scores.length === 1) {
			const score = scores[0];
			return Math.max(-1, Math.min(1, score));
		}

		let maxScore = -Infinity;
		for (const score of scores) {
			if (score > maxScore) {
				maxScore = score;
			}
		}

		let sumExp = 0;
		for (const score of scores) {
			sumExp += Math.exp(PASSAGE_AGGREGATION_BETA * (score - maxScore));
		}

		const aggregated = maxScore + Math.log(sumExp) / PASSAGE_AGGREGATION_BETA;
		return Math.max(-1, Math.min(1, aggregated));
	}
}

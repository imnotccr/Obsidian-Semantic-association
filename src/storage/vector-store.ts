/**
 * VectorStore - 向量存储与相似度检索（核心“向量数据库”）。
 *
 * 在本插件里，几乎所有“语义”能力都建立在向量相似度之上：
 * - Indexing：把 note/chunk 的文本转成 embedding 向量并写入 VectorStore
 * - Connections：用当前笔记向量去检索相似的 chunk/note
 * - Lookup：把 query 向量去检索相似的 chunk
 *
 * ## id 规则（非常重要）
 * - note-level 向量 id：直接使用 `notePath`（例如 `notes/A.md`）
 * - chunk-level 向量 id：使用 `${notePath}#${order}`（例如 `notes/A.md#3`）
 *
 * 这让我们可以：
 * - 通过 `id.includes('#')` 快速区分 chunk 向量
 * - 通过 `lastIndexOf('#')` 从 chunkId 反推出 notePath（Lookup/Connections 都会用到）
 *
 * ## 相似度：余弦相似度（cosine similarity）
 * `score = dot(q, v) / (||q|| * ||v||)`
 *
 * 性能优化：
 * - 每个向量预计算 `invNorm = 1 / ||v||`，搜索时就不必重复开方
 * - 搜索 topK 使用固定大小的小根堆（min-heap），复杂度约为 `O(N log K)`
 *
 * ## 持久化：JSON + 二进制
 * - `serialize()/load()`：全 JSON（早期格式，体积较大）
 * - `serializeBinary()/loadBinary()`：元数据走 JSON，向量主体走 float32 二进制（更小更快）
 */
import type { Vector } from "../types";

/** JSON 快照格式（v1）：向量以 number[] 形式存储，体积较大但易读。 */
interface VectorStoreData {
	version: number;
	vectors: Record<string, number[]>;
	dimension: number;
}

type VectorEntry = {
	/** 用 Float32Array 存储，节省内存并且更接近 embeddings 的真实格式。 */
	vector: Float32Array;
	/** 预计算的 `1 / ||vector||`，用于加速余弦相似度计算。 */
	invNorm: number;
};

/**
 * 二进制快照的元数据（保存在 index-store.json 里）。
 *
 * 向量主体会写入 `index-vectors.bin`，按 ids 顺序连续存放 float32。
 */
export interface VectorStoreBinaryMetadata {
	version: number;
	encoding: "float32-le";
	dimension: number;
	vectorCount: number;
	ids: string[];
}

/** 用于“存储统计”展示：向量总数、分项数量、维度等。 */
export interface VectorStoreBreakdown {
	vectorCount: number;
	noteVectorCount: number;
	chunkVectorCount: number;
	dimension: number;
}

/** VectorStore.search 的单条命中结果。 */
export interface VectorSearchResult {
	id: string;
	score: number;
}

const CURRENT_VERSION = 1;
const CURRENT_BINARY_VERSION = 2;

export class VectorStore {
	/**
	 * 主存储：id -> VectorEntry。
	 *
	 * 这里存的是“已验证且维度一致”的向量。
	 */
	private vectors: Map<string, VectorEntry> = new Map();

	/**
	 * 当前维度（dimension）。
	 *
	 * 约定：同一个 VectorStore 内所有向量维度必须一致。
	 * - 初始为 0（未知）
	 * - 第一次 set/load 时确定
	 */
	private dimension = 0;

	/**
	 * 从 JSON 快照恢复（旧格式：向量存 number[]）。
	 *
	 * 会做严格校验：
	 * - raw 是否是对象、版本号是否匹配
	 * - 每个 vector 是否为有限数值、维度是否一致
	 * 校验失败会直接 clear，避免后续相似度计算出现 NaN/崩溃。
	 */
	load(raw: unknown): void {
		if (!raw || typeof raw !== "object") {
			this.clear();
			return;
		}

		const data = raw as VectorStoreData;
		if (data.version !== CURRENT_VERSION || !data.vectors) {
			this.clear();
			return;
		}

		const nextVectors = new Map<string, VectorEntry>();
		let nextDimension =
			typeof data.dimension === "number" && Number.isInteger(data.dimension) && data.dimension > 0
				? data.dimension
				: 0;

		for (const [id, vec] of Object.entries(data.vectors)) {
			const expectedDimension = nextDimension === 0 ? undefined : nextDimension;
			const entry = this.createVectorEntry(vec, id, expectedDimension);
			if (nextDimension === 0) {
				nextDimension = entry.vector.length;
			}
			nextVectors.set(id, entry);
		}

		this.vectors = nextVectors;
		this.dimension = nextVectors.size > 0 ? nextDimension : 0;
	}

	/** 序列化为 JSON 快照（旧格式，主要用于兼容）。 */
	serialize(): VectorStoreData {
		const vectors: Record<string, number[]> = {};
		for (const [id, entry] of this.vectors) {
			vectors[id] = Array.from(entry.vector);
		}

		return {
			version: CURRENT_VERSION,
			vectors,
			dimension: this.dimension,
		};
	}

	/**
	 * 序列化为二进制快照：
	 * - metadata：写入 index-store.json
	 * - buffer：写入 index-vectors.bin
	 *
	 * 二进制布局：按 ids 顺序，把每个向量的 float32 连续写入。
	 */
	serializeBinary(): { metadata: VectorStoreBinaryMetadata; buffer: ArrayBuffer } {
		const ids = Array.from(this.vectors.keys());
		const buffer = new ArrayBuffer(ids.length * this.dimension * 4);
		const floatView = new Float32Array(buffer);
		let floatOffset = 0;

		for (const id of ids) {
			const entry = this.vectors.get(id);
			if (!entry) {
				throw new Error(`VectorStore: missing vector for ${id} during binary serialization`);
			}

			floatView.set(entry.vector, floatOffset);
			floatOffset += this.dimension;
		}

		return {
			metadata: {
				version: CURRENT_BINARY_VERSION,
				encoding: "float32-le",
				dimension: this.dimension,
				vectorCount: ids.length,
				ids,
			},
			buffer,
		};
	}

	/**
	 * 从二进制快照恢复向量。
	 *
	 * 说明：这里把 Float32Array.subarray(...) 直接存入 Map，
	 * 它们共享同一个底层 ArrayBuffer（性能更好、内存更省）。
	 */
	loadBinary(raw: unknown, binary: ArrayBuffer): void {
		this.clear();

		if (!raw || typeof raw !== "object") {
			throw new Error("VectorStore: invalid binary metadata");
		}

		const metadata = raw as VectorStoreBinaryMetadata;
		if (
			metadata.version !== CURRENT_BINARY_VERSION ||
			metadata.encoding !== "float32-le" ||
			!Array.isArray(metadata.ids)
		) {
			throw new Error("VectorStore: unsupported binary metadata");
		}

		if (!Number.isInteger(metadata.dimension) || metadata.dimension < 0) {
			throw new Error("VectorStore: invalid binary metadata dimension");
		}

		if (!Number.isInteger(metadata.vectorCount) || metadata.vectorCount < 0) {
			throw new Error("VectorStore: invalid binary metadata vector count");
		}

		if (metadata.ids.length !== metadata.vectorCount) {
			throw new Error("VectorStore: binary metadata ids/vectorCount mismatch");
		}

		const expectedBytes = metadata.vectorCount * metadata.dimension * 4;
		if (binary.byteLength !== expectedBytes) {
			throw new Error(
				`VectorStore: binary snapshot size mismatch, expected ${expectedBytes}, got ${binary.byteLength}`,
			);
		}

		const floats = new Float32Array(binary);

		for (let index = 0; index < metadata.ids.length; index++) {
			const id = metadata.ids[index];
			if (typeof id !== "string" || id.length === 0) {
				throw new Error("VectorStore: invalid vector id in binary metadata");
			}

			const start = index * metadata.dimension;
			const end = start + metadata.dimension;
			const vector = floats.subarray(start, end);

			this.vectors.set(id, {
				vector,
				invNorm: this.computeInvNorm(vector),
			});
		}

		this.dimension = metadata.vectorCount > 0 ? metadata.dimension : 0;
	}

	/**
	 * 统计当前存储的向量数量与分布（note vs chunk）。
	 *
	 * 判定方式：id 包含 `#` 视为 chunk 向量，否则为 note 向量。
	 */
	getBreakdown(): VectorStoreBreakdown {
		let noteVectorCount = 0;
		let chunkVectorCount = 0;

		for (const id of this.vectors.keys()) {
			if (id.includes("#")) {
				chunkVectorCount++;
			} else {
				noteVectorCount++;
			}
		}

		return {
			vectorCount: this.vectors.size,
			noteVectorCount,
			chunkVectorCount,
			dimension: this.dimension,
		};
	}

	/**
	 * 写入/更新一个向量。
	 *
	 * - 如果 VectorStore 还没有 dimension，则用该向量长度作为 dimension
	 * - 如果已有 dimension，则要求 vector.length 必须一致
	 */
	set(id: string, vector: Vector): void {
		const expectedDimension = this.dimension === 0 ? undefined : this.dimension;
		const entry = this.createVectorEntry(vector, id, expectedDimension);
		if (this.dimension === 0) {
			this.dimension = entry.vector.length;
		}

		this.vectors.set(id, entry);
	}

	/** 批量写入（内部仍逐条 set，保证维度校验一致）。 */
	setBatch(entries: Array<{ id: string; vector: Vector }>): void {
		for (const { id, vector } of entries) {
			this.set(id, vector);
		}
	}

	/**
	 * 读取一个向量（返回 number[]）。
	 *
	 * 注意：这里会 `Array.from(Float32Array)` 生成新数组，
	 * 适合“读少量向量”或“需要可序列化结果”的场景。
	 * 对于大批量计算，建议直接在 VectorStore 内部完成（例如 search）。
	 */
	get(id: string): Vector | undefined {
		const entry = this.vectors.get(id);
		return entry ? Array.from(entry.vector) : undefined;
	}

	/** 删除一个向量条目。 */
	delete(id: string): boolean {
		const deleted = this.vectors.delete(id);
		this.resetDimensionIfEmpty();
		return deleted;
	}

	/**
	 * 删除某个前缀下的所有向量。
	 *
	 * 常见用法：删除一篇笔记的所有 chunk 向量（prefix=`${notePath}#`）。
	 */
	deleteByPrefix(prefix: string): void {
		for (const id of Array.from(this.vectors.keys())) {
			if (id.startsWith(prefix)) {
				this.vectors.delete(id);
			}
		}

		this.resetDimensionIfEmpty();
	}

	/**
	 * 批量迁移 id 前缀（用于 rename）。
	 *
	 * 例：
	 * - oldPrefix = "old/path.md"
	 * - newPrefix = "new/path.md"
	 * 会把：
	 * - "old/path.md"（note 向量）
	 * - "old/path.md#0"、"old/path.md#1"（chunk 向量）
	 * 迁移为 newPrefix 对应的 id。
	 */
	rename(oldPrefix: string, newPrefix: string): void {
		const toMigrate: Array<{ oldId: string; newId: string; entry: VectorEntry }> = [];

		for (const [id, entry] of this.vectors) {
			if (id.startsWith(oldPrefix)) {
				const suffix = id.slice(oldPrefix.length);
				toMigrate.push({ oldId: id, newId: newPrefix + suffix, entry });
			}
		}

		for (const { oldId, newId, entry } of toMigrate) {
			this.vectors.delete(oldId);
			this.vectors.set(newId, entry);
		}
	}

	/**
	 * 在当前向量集合中执行 topK 相似度检索。
	 *
	 * @param query    - 查询向量（维度必须与 VectorStore.dimension 一致）
	 * @param topK     - 返回的最大条数
	 * @param filterFn - 可选过滤函数（例如只检索 chunk 向量：id.includes('#')）
	 *
	 * @returns 按 score 从高到低排序的命中结果列表
	 */
	search(
		query: Vector,
		topK: number,
		filterFn?: (id: string) => boolean,
	): VectorSearchResult[] {
		if (!Number.isInteger(topK) || topK <= 0 || this.vectors.size === 0) {
			return [];
		}

		if (this.dimension > 0 && query.length !== this.dimension) {
			throw new Error(
				`VectorStore: query dimension mismatch, expected ${this.dimension}, got ${query.length}`,
			);
		}

		const { vector: queryVector, invNorm: queryInvNorm } = this.createVectorEntry(
			query,
			"__query__",
			this.dimension === 0 ? undefined : this.dimension,
		);
		if (!Number.isFinite(queryInvNorm) || queryInvNorm === 0) {
			return [];
		}

		const limit = Math.min(topK, this.vectors.size);
		const heap: VectorSearchResult[] = [];

		const swap = (a: number, b: number): void => {
			const tmp = heap[a];
			heap[a] = heap[b];
			heap[b] = tmp;
		};

		const siftUp = (index: number): void => {
			let current = index;
			while (current > 0) {
				const parent = (current - 1) >> 1;
				if (heap[parent].score <= heap[current].score) {
					return;
				}
				swap(parent, current);
				current = parent;
			}
		};

		const siftDown = (index: number): void => {
			let current = index;
			while (true) {
				const left = current * 2 + 1;
				if (left >= heap.length) {
					return;
				}
				const right = left + 1;
				const smallest =
					right < heap.length && heap[right].score < heap[left].score
						? right
						: left;
				if (heap[current].score <= heap[smallest].score) {
					return;
				}
				swap(current, smallest);
				current = smallest;
			}
		};

		for (const [id, entry] of this.vectors) {
			if (filterFn && !filterFn(id)) {
				continue;
			}

			const invNorm = entry.invNorm;
			if (!Number.isFinite(invNorm) || invNorm === 0) {
				continue;
			}

			const vec = entry.vector;
			let dotProduct = 0;
			for (let i = 0; i < vec.length; i++) {
				dotProduct += queryVector[i] * vec[i];
			}

			const score = dotProduct * queryInvNorm * invNorm;
			if (!Number.isFinite(score)) {
				continue;
			}
			if (heap.length < limit) {
				heap.push({ id, score });
				siftUp(heap.length - 1);
				continue;
			}

			if (score > heap[0].score) {
				heap[0].id = id;
				heap[0].score = score;
				siftDown(0);
			}
		}

		heap.sort((a, b) => b.score - a.score);
		return heap;
	}

	/** 当前向量总数。 */
	get size(): number {
		return this.vectors.size;
	}

	/** 清空全部向量，并重置 dimension。 */
	clear(): void {
		this.vectors.clear();
		this.dimension = 0;
	}

	/**
	 * 把 unknown 输入校验并转成 VectorEntry：
	 * - 校验是数组且非空
	 * - 校验维度一致（如果 expectedDimension 提供）
	 * - 校验每个值是有限 number
	 * 同时预计算 invNorm。
	 */
	private createVectorEntry(
		vector: unknown,
		id: string,
		expectedDimension?: number,
	): VectorEntry {
		if (!Array.isArray(vector) || vector.length === 0) {
			throw new Error(`VectorStore: invalid vector for ${id}`);
		}

		if (expectedDimension !== undefined && vector.length !== expectedDimension) {
			throw new Error(
				`VectorStore: dimension mismatch for ${id}, expected ${expectedDimension}, got ${vector.length}`,
			);
		}

		const output = new Float32Array(vector.length);
		let normSquared = 0;
		for (let i = 0; i < vector.length; i++) {
			const value = vector[i];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`VectorStore: non-finite vector value for ${id}`);
			}
			output[i] = value;
			normSquared += value * value;
		}

		return {
			vector: output,
			invNorm: normSquared > 0 ? 1 / Math.sqrt(normSquared) : 0,
		};
	}

	/** 从 Float32Array 重新计算 invNorm（用于 loadBinary）。 */
	private computeInvNorm(vector: Float32Array): number {
		let normSquared = 0;
		for (let i = 0; i < vector.length; i++) {
			const value = vector[i];
			if (!Number.isFinite(value)) {
				return 0;
			}
			normSquared += value * value;
		}
		if (!Number.isFinite(normSquared) || normSquared <= 0) {
			return 0;
		}
		return 1 / Math.sqrt(normSquared);
	}

	/** 如果 vectors 为空，则把 dimension 重置为 0（未知）。 */
	private resetDimensionIfEmpty(): void {
		if (this.vectors.size === 0) {
			this.dimension = 0;
		}
	}
}

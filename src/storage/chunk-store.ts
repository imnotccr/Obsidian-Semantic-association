/**
 * ChunkStore - 语义块元数据存储
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Storage Layer（存储层）                        │
 * │  被谁调用：ReindexService（写入）、PassageSelector（读取）      │
 * │           ConnectionsService（读取）、LookupService（读取）     │
 * │  参见：ARCHITECTURE.md「三、核心数据结构 → ChunkMeta」          │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 负责管理所有 chunk（语义块）的元数据。一篇笔记会被 Chunker 切分为
 * 多个 chunk，每个 chunk 代表一个标题块或段落块。
 *
 * ## 为什么需要两级索引
 *
 * 系统中有两种访问模式：
 * 1. 按 chunkId 查找：LookupService 搜索到某个 chunk 后，需要获取其文本内容
 * 2. 按 notePath 查找：PassageSelector 需要获取候选笔记的「所有 chunks」来做精排
 *
 * 如果只有单级索引，第二种访问模式就需要遍历全部 chunks 做过滤，O(n)。
 * 加上 noteChunks 反向索引后，两种模式都是 O(1)。
 *
 * ## chunkId 命名规则
 *
 * 格式：`${notePath}#${order}`
 * 例如：`notes/Python基础.md#0`、`notes/Python基础.md#1`
 *
 * 选择这个格式的原因：
 * - 与 VectorStore 共享同一个 id 体系
 * - 通过 `#` 可以区分 note-level 向量和 chunk-level 向量
 * - LookupService 可以通过 lastIndexOf('#') 从 chunkId 反推 notePath
 *
 * ## 数据流
 *
 * 写入路径：
 *   Chunker.chunk() → ReindexService.indexFile() → ChunkStore.replaceByNote()
 *
 * 读取路径（Connections 场景）：
 *   ConnectionsService → PassageSelector.selectBest()
 *     → ChunkStore.getByNote(candidatePath)  // 取候选笔记的所有 chunks
 *
 * 读取路径（Lookup 场景）：
 *   LookupService.search() → ChunkStore.get(chunkId)  // 取搜到的 chunk 详情
 */

import type { ChunkMeta } from "../types";

/**
 * 持久化数据格式
 *
 * 只存储 chunks Map 的内容（chunkId → ChunkMeta），
 * noteChunks 反向索引在 load() 时自动重建，不需要持久化。
 */
interface ChunkStoreData {
	version: number;
	chunks: Record<string, ChunkMeta>;
}

const CURRENT_VERSION = 1;

export class ChunkStore {
	/**
	 * 一级索引（全局）：chunkId → ChunkMeta
	 *
	 * 用于按 chunkId 直接查找，时间复杂度 O(1)。
	 * 典型调用场景：LookupService 搜到 chunkId 后获取文本内容。
	 */
	private chunks: Map<string, ChunkMeta> = new Map();

	/**
	 * 二级索引（按笔记聚合）：notePath → chunkId[]
	 *
	 * 这是一个反向索引，用于快速获取某篇笔记的所有 chunks。
	 * 典型调用场景：PassageSelector 需要遍历候选笔记的所有 chunks。
	 *
	 * 注意：这个索引不需要持久化，load() 时从一级索引自动重建。
	 */
	private noteChunks: Map<string, string[]> = new Map();

	/**
	 * 从持久化数据恢复
	 *
	 * 恢复一级索引的同时，自动重建二级索引 noteChunks。
	 * 这样持久化文件只需要存一份数据，减少磁盘占用和一致性风险。
	 */
	load(raw: unknown): void {
		this.chunks.clear();
		this.noteChunks.clear();

		if (!raw || typeof raw !== "object") return;

		const data = raw as ChunkStoreData;
		if (data.version !== CURRENT_VERSION || !data.chunks) return;

		for (const [id, chunk] of Object.entries(data.chunks)) {
			this.chunks.set(id, chunk);
			// 逐条重建二级索引
			this.addToNoteIndex(chunk.notePath, id);
		}
	}

	/**
	 * 导出为可持久化对象
	 *
	 * 只导出一级索引内容，二级索引在 load 时自动重建。
	 */
	serialize(): ChunkStoreData {
		const chunks: Record<string, ChunkMeta> = {};
		for (const [id, chunk] of this.chunks) {
			chunks[id] = chunk;
		}
		return { version: CURRENT_VERSION, chunks };
	}

	/**
	 * 按 chunkId 获取单个 chunk
	 *
	 * 使用场景：LookupService 搜索到某个 chunkId 后，
	 * 需要获取其 heading 和 text 用于展示。
	 */
	get(chunkId: string): ChunkMeta | undefined {
		return this.chunks.get(chunkId);
	}

	/**
	 * 获取指定笔记的所有 chunks，按 order 排序
	 *
	 * 使用场景：
	 * 1. PassageSelector 需要遍历候选笔记的所有 chunks 做精排
	 * 2. ConnectionsService 获取当前笔记的 chunk 向量集合
	 *
	 * 排序保证：返回的 chunks 按在原文中的出现顺序排列（order 字段）。
	 */
	getByNote(notePath: string): ChunkMeta[] {
		const ids = this.noteChunks.get(notePath);
		if (!ids) return [];

		return ids
			.map((id) => this.chunks.get(id))
			// 类型守卫：过滤掉理论上不应出现的 undefined
			.filter((c): c is ChunkMeta => c !== undefined)
			// 按原文顺序排列
			.sort((a, b) => a.order - b.order);
	}

	/** 获取所有 chunks（用于调试或全量导出） */
	getAll(): ChunkMeta[] {
		return Array.from(this.chunks.values());
	}

	/**
	 * 新增或更新单个 chunk
	 *
	 * 同时维护两级索引的一致性：
	 * 1. 写入一级索引 chunks Map
	 * 2. 更新二级索引 noteChunks Map
	 */
	set(chunk: ChunkMeta): void {
		this.chunks.set(chunk.chunkId, chunk);
		this.addToNoteIndex(chunk.notePath, chunk.chunkId);
	}

	/**
	 * 替换指定笔记的所有 chunks
	 *
	 * 这是最常用的写入方法。当一篇笔记被修改后，Chunker 会重新切分，
	 * 产生全新的 chunks 列表。此方法先删除旧的 chunks，再写入新的，
	 * 保证数据一致性。
	 *
	 * 为什么不直接 set？因为修改后的笔记可能：
	 * - chunk 数量变化（如新增/删除了一个标题）
	 * - chunk 顺序变化（如调整了标题位置）
	 * 直接 set 会导致旧的 chunks 残留，所以必须先清再写。
	 */
	replaceByNote(notePath: string, chunks: ChunkMeta[]): void {
		this.deleteByNote(notePath);
		for (const chunk of chunks) {
			this.set(chunk);
		}
	}

	/**
	 * 删除指定笔记的所有 chunks（级联删除）
	 *
	 * 使用场景：
	 * 1. 文件被删除时，清理其所有 chunks
	 * 2. replaceByNote 的第一步，清除旧数据
	 *
	 * 通过二级索引快速定位该笔记的所有 chunkId，
	 * 避免遍历全部 chunks。
	 */
	deleteByNote(notePath: string): void {
		const ids = this.noteChunks.get(notePath);
		if (!ids) return;

		// 从一级索引中逐个删除
		for (const id of ids) {
			this.chunks.delete(id);
		}
		// 删除二级索引条目
		this.noteChunks.delete(notePath);
	}

	/**
	 * 处理文件重命名
	 *
	 * 重命名时，每个 chunk 的 notePath 和 chunkId 都需要更新：
	 * - notePath: "old/path.md" → "new/path.md"
	 * - chunkId: "old/path.md#0" → "new/path.md#0"
	 *
	 * 操作步骤：
	 * 1. 取出旧路径下的所有 chunks（保留 heading、text、order、vector）
	 * 2. 删除旧路径的所有索引
	 * 3. 更新每个 chunk 的 notePath 和 chunkId
	 * 4. 以新路径重新写入两级索引
	 *
	 * 注意：调用方还需要同步更新 VectorStore 中对应向量的 id。
	 */
	rename(oldPath: string, newPath: string): void {
		const oldChunks = this.getByNote(oldPath);
		if (oldChunks.length === 0) return;

		this.deleteByNote(oldPath);

		for (const chunk of oldChunks) {
			chunk.notePath = newPath;
			// chunkId 格式：${notePath}#${order}
			chunk.chunkId = `${newPath}#${chunk.order}`;
			this.set(chunk);
		}
	}

	/** 当前存储的 chunk 总数 */
	get size(): number {
		return this.chunks.size;
	}

	/** 清空所有数据（两级索引同时清空） */
	clear(): void {
		this.chunks.clear();
		this.noteChunks.clear();
	}

	/**
	 * 维护二级索引：将 chunkId 添加到 noteChunks 中
	 *
	 * 内部方法，由 set() 调用。
	 * 使用 includes() 防止重复添加（replaceByNote 场景下不会重复，
	 * 但单独调用 set() 时可能更新已有 chunk）。
	 */
	private addToNoteIndex(notePath: string, chunkId: string): void {
		const ids = this.noteChunks.get(notePath);
		if (ids) {
			if (!ids.includes(chunkId)) {
				ids.push(chunkId);
			}
		} else {
			this.noteChunks.set(notePath, [chunkId]);
		}
	}
}

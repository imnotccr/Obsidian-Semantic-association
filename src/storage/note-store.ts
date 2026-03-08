/**
 * NoteStore - 笔记元数据存储
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Storage Layer（存储层）                    │
 * │  被谁调用：ReindexService（写入）、ConnectionsService（读取）│
 * │  参见：ARCHITECTURE.md「三、核心数据结构 → NoteMeta」       │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 负责管理 vault 中所有已索引笔记的 NoteMeta 元数据。
 * 这是系统中"笔记级"信息的唯一数据源。
 *
 * ## 为什么需要 NoteStore
 *
 * Obsidian 自身有 MetadataCache，但它不存储我们需要的语义信息
 * （如 summaryText、hash、note-level vector）。NoteStore 是我们自己的
 * 笔记级索引，在 MetadataCache 基础上扩展了语义检索所需的字段。
 *
 * ## 存储策略
 *
 * - 运行时：内存 Map<path, NoteMeta>，查询时间 O(1)
 * - 持久化：序列化为 JSON，由调用方（main.ts）决定写入时机
 * - 版本号：用于未来数据格式升级时的兼容性处理
 *
 * ## 数据流
 *
 * 写入路径：
 *   Scanner.buildNoteMeta() → ReindexService.indexFile() → NoteStore.set()
 *
 * 读取路径：
 *   ConnectionsService.findConnections() → NoteStore.get(candidatePath)
 *   LookupService.search() → NoteStore.get(notePath)
 */

import type { NoteMeta } from "../types";

/**
 * 持久化文件中的数据格式
 *
 * 包含版本号用于未来的数据迁移。当 CURRENT_VERSION 升级时，
 * load() 方法可以根据旧版本号执行相应的迁移逻辑。
 */
interface NoteStoreData {
	version: number;
	notes: Record<string, NoteMeta>;
}

/** 当前数据格式版本，升级时递增 */
const CURRENT_VERSION = 1;

export class NoteStore {
	/**
	 * 内存主索引：path → NoteMeta
	 *
	 * 使用文件路径作为 key，因为：
	 * 1. 路径在 vault 中是唯一的
	 * 2. Obsidian 所有文件操作都以路径为参数
	 * 3. 与 ChunkStore、VectorStore 的 key 格式保持一致
	 */
	private notes: Map<string, NoteMeta> = new Map();

	/**
	 * 从持久化数据恢复内存索引
	 *
	 * 插件启动时调用，从磁盘 JSON 文件中恢复上次的索引状态，
	 * 避免每次启动都要全量重建索引。
	 *
	 * @param raw - 从 JSON 文件读取的原始数据（类型不确定，需要校验）
	 *
	 * 防御性设计：
	 * - raw 可能是 null/undefined（首次启动时无数据文件）
	 * - raw 可能是旧版本格式（version 不匹配）
	 * - 以上情况都静默处理，由调用方决定是否触发全量索引
	 */
	load(raw: unknown): void {
		this.notes.clear();

		// 防御性类型检查：首次启动时 raw 为 null
		if (!raw || typeof raw !== "object") return;

		const data = raw as NoteStoreData;
		// 版本不匹配时丢弃旧数据，后续会触发全量重建
		if (data.version !== CURRENT_VERSION || !data.notes) return;

		for (const [path, meta] of Object.entries(data.notes)) {
			this.notes.set(path, meta);
		}
	}

	/**
	 * 导出为可持久化的数据结构
	 *
	 * 将内存 Map 转换为纯 JSON 对象，用于写入磁盘。
	 * Map 不能直接 JSON.stringify，所以需要手动转为 Record。
	 *
	 * @returns 包含版本号的可序列化对象
	 */
	serialize(): NoteStoreData {
		const notes: Record<string, NoteMeta> = {};
		for (const [path, meta] of this.notes) {
			notes[path] = meta;
		}
		return { version: CURRENT_VERSION, notes };
	}

	/** 获取单条笔记元数据，O(1) 时间复杂度 */
	get(path: string): NoteMeta | undefined {
		return this.notes.get(path);
	}

	/** 获取所有笔记元数据（用于遍历场景） */
	getAll(): NoteMeta[] {
		return Array.from(this.notes.values());
	}

	/** 获取所有已索引的笔记路径（用于与 vault 文件列表做差集） */
	getAllPaths(): string[] {
		return Array.from(this.notes.keys());
	}

	/**
	 * 新增或更新笔记元数据
	 *
	 * 由 ReindexService.indexFile() 在索引完成后调用。
	 * 如果该路径已存在，会被新数据覆盖（upsert 语义）。
	 */
	set(meta: NoteMeta): void {
		this.notes.set(meta.path, meta);
	}

	/** 批量设置（用于初始化等场景，减少方法调用开销） */
	setBatch(metas: NoteMeta[]): void {
		for (const meta of metas) {
			this.notes.set(meta.path, meta);
		}
	}

	/**
	 * 删除指定路径的笔记
	 *
	 * 注意：调用方（ReindexService.removeFile）还需要同步删除
	 * ChunkStore 和 VectorStore 中的关联数据，这里只负责自身。
	 *
	 * @returns 是否成功删除（路径不存在时返回 false）
	 */
	delete(path: string): boolean {
		return this.notes.delete(path);
	}

	/**
	 * 处理文件重命名
	 *
	 * 重命名不等于「删除旧 + 创建新」，因为我们要保留已计算的
	 * vector 和其他元数据，避免不必要的重新索引。
	 *
	 * 操作步骤：
	 * 1. 从旧路径取出元数据
	 * 2. 删除旧路径的条目
	 * 3. 更新元数据中的 path 字段
	 * 4. 以新路径重新写入
	 *
	 * 注意：调用方还需要同步更新 ChunkStore 和 VectorStore 中的路径。
	 */
	rename(oldPath: string, newPath: string): void {
		const meta = this.notes.get(oldPath);
		if (!meta) return;

		this.notes.delete(oldPath);
		meta.path = newPath;
		this.notes.set(newPath, meta);
	}

	/** 判断路径是否已有索引（用于增量索引时判断是新建还是更新） */
	has(path: string): boolean {
		return this.notes.has(path);
	}

	/**
	 * 当前已索引笔记数量
	 *
	 * 用途：
	 * - main.ts 启动时判断是否需要全量索引（size === 0）
	 * - ConnectionsView 判断索引是否可用
	 * - 重建索引时的进度显示
	 */
	get size(): number {
		return this.notes.size;
	}

	/** 清空所有数据（全量重建索引前调用） */
	clear(): void {
		this.notes.clear();
	}
}

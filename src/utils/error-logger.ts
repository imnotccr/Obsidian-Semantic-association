/**
 * ErrorLogger - 索引错误日志记录与清理服务
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Utils Layer（工具层）                                │
 * │  被谁调用：                                                          │
 * │    - ReindexService（索引失败时写入日志）                             │
 * │    - main.ts（启动时加载日志 + 清理）                                │
 * │  参见：ARCHITECTURE.md「十、错误日志机制」                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ## 为什么需要 ErrorLogger
 *
 * 之前索引失败只打印到 console.error，用户关掉开发者工具后无法查看。
 * ErrorLogger 将错误持久化到 JSON 文件中，用户可以随时查看和诊断。
 *
 * ## 存储位置
 *
 * 日志存储在插件配置目录下：
 * `{vault}/.obsidian/plugins/semantic-connections/error-log.json`
 *
 * ## 清理策略：容量上限 + 时间过期
 *
 * 采用双重控制，比单纯的定期删除更合理：
 *
 * ### 1. 容量上限（MAX_ENTRIES = 500）
 * 每次 log() 时检查，超过上限则截断最旧的条目。
 * 这能防止 API Key 失效等场景下短时间暴增到几千条。
 *
 * ### 2. 时间过期（30 天）
 * 启动时执行懒清理，删除 30 天前的条目。
 * 确保长期不出错的用户不会一直累积旧数据。
 *
 * ### 为什么不用纯定期删除？
 * - 如果短时间内大量失败（如 API Key 失效），日志可能暴增，纯时间控制不住
 * - 如果用户长时间没有错误，30 天定期清理是浪费
 * - 容量上限提供了实时保护，时间过期提供了周期性清理
 *
 * ## 写入策略
 *
 * - `log()` 只写入内存（快），适合在 indexAll 循环中批量记录
 * - `logAndSave()` 写入内存 + 持久化（慢），适合增量索引等需要即时持久化的场景
 * - `save()` 由调用方在合适时机手动触发（如 indexAll 结束后）
 */

import type { DataAdapter } from "obsidian";
import type { IndexErrorEntry } from "../types";

/** 日志文件的持久化格式 */
interface ErrorLogData {
	version: number;
	/** 上次执行时间过期清理的时间戳（ms since epoch） */
	lastCleanup: number;
	/** 错误日志条目（按时间顺序追加） */
	entries: IndexErrorEntry[];
}

const CURRENT_VERSION = 1;

/**
 * 容量上限：最多保留 500 条日志
 *
 * 选择 500 的原因：
 * - 足够大：覆盖大多数排查场景（500 条 × 平均 200 字节 ≈ 100KB）
 * - 足够小：不会显著占用磁盘空间
 * - JSON 文件可控：500 条序列化后用编辑器打开不卡顿
 */
const MAX_ENTRIES = 500;

/** 时间过期周期：30 天（毫秒） */
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export class ErrorLogger {
	/** 内存中的日志条目 */
	private entries: IndexErrorEntry[] = [];

	/** 上次执行时间过期清理的时间戳 */
	private lastCleanup: number = 0;

	/** 是否有未保存的变更 */
	private dirty = false;

	/**
	 * @param adapter - Obsidian DataAdapter，用于文件读写
	 * @param logPath - 日志文件路径（相对于 vault 根目录）
	 */
	constructor(
		private adapter: DataAdapter,
		private logPath: string,
	) {}

	/**
	 * 从磁盘加载错误日志
	 *
	 * 首次使用时文件不存在，静默处理并从空状态开始。
	 * 文件损坏时同样静默处理，避免阻塞插件启动。
	 */
	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.logPath)) {
				const raw = await this.adapter.read(this.logPath);
				const data = JSON.parse(raw) as ErrorLogData;

				if (data.version === CURRENT_VERSION) {
					this.entries = data.entries || [];
					this.lastCleanup = data.lastCleanup || 0;
				}
			}
		} catch (err) {
			// 文件不存在或损坏，从空状态开始
			console.warn("ErrorLogger: failed to load, starting fresh", err);
			this.entries = [];
			this.lastCleanup = 0;
		}
	}

	/**
	 * 将当前日志写入磁盘
	 *
	 * 使用 JSON.stringify(data, null, 2) 格式化输出，
	 * 方便用户直接用文本编辑器查看。
	 */
	async save(): Promise<void> {
		if (!this.dirty && this.entries.length === 0) return;

		const data: ErrorLogData = {
			version: CURRENT_VERSION,
			lastCleanup: this.lastCleanup,
			entries: this.entries,
		};

		try {
			await this.adapter.write(
				this.logPath,
				JSON.stringify(data, null, 2),
			);
			this.dirty = false;
		} catch (err) {
			console.error("ErrorLogger: failed to save", err);
		}
	}

	/**
	 * 记录一条索引错误（仅写入内存）
	 *
	 * 在 indexAll 循环中使用：先批量记录，结束后统一 save()。
	 * 这样 N 次错误只做 1 次磁盘写入，不影响索引性能。
	 *
	 * ## 容量保护
	 *
	 * 每次 log 后检查是否超过 MAX_ENTRIES。超过时截断最旧的条目，
	 * 防止异常场景（如 API Key 失效导致所有文件都失败）下日志暴增。
	 */
	log(entry: Omit<IndexErrorEntry, "timestamp">): void {
		this.entries.push({
			...entry,
			timestamp: Date.now(),
		});

		// 容量上限保护：超过时截断最旧的条目
		if (this.entries.length > MAX_ENTRIES) {
			const overflow = this.entries.length - MAX_ENTRIES;
			this.entries = this.entries.slice(overflow);
		}

		this.dirty = true;
	}

	/**
	 * 记录并立即持久化
	 *
	 * 用于增量索引（ReindexQueue 触发的单文件任务）：
	 * 单文件失败后立即保存，确保即使后续崩溃也不丢失日志。
	 */
	async logAndSave(entry: Omit<IndexErrorEntry, "timestamp">): Promise<void> {
		this.log(entry);
		await this.save();
	}

	/**
	 * 清理过期日志：删除超过 30 天的条目
	 *
	 * 在插件启动时（onLayoutReady）调用。
	 *
	 * 与容量上限的分工：
	 * - 容量上限（MAX_ENTRIES）：实时保护，防止短时间暴增
	 * - 时间过期（30天）：周期性清理，确保旧数据不永久累积
	 *
	 * 判断逻辑：
	 * - 如果 lastCleanup 距今不足 30 天 → 跳过（避免每次启动都遍历）
	 * - 如果超过 30 天 → 过滤掉 30 天前的条目并保存
	 *
	 * @returns 本次清理删除的条目数
	 */
	async cleanupIfNeeded(): Promise<number> {
		const now = Date.now();

		// 距上次清理不足 30 天，跳过
		if (this.lastCleanup > 0 && (now - this.lastCleanup) < EXPIRY_MS) {
			return 0;
		}

		const cutoff = now - EXPIRY_MS;
		const before = this.entries.length;
		this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
		const removed = before - this.entries.length;

		this.lastCleanup = now;

		// 有条目被清理或有历史数据时才写入
		if (removed > 0 || before > 0) {
			this.dirty = true;
			await this.save();
			console.log(
				`ErrorLogger: cleaned up ${removed} expired entries (${this.entries.length} remaining)`,
			);
		}

		return removed;
	}

	/**
	 * 获取最近的 N 条错误日志
	 *
	 * 用于 UI 展示或诊断时查看最近的错误。
	 */
	getRecent(count: number = 50): IndexErrorEntry[] {
		return this.entries.slice(-count);
	}

	/**
	 * 获取指定文件的所有错误日志
	 *
	 * 用于诊断某个文件为什么反复索引失败。
	 */
	getByFile(filePath: string): IndexErrorEntry[] {
		return this.entries.filter((e) => e.filePath === filePath);
	}

	/** 当前日志条目总数 */
	get size(): number {
		return this.entries.length;
	}

	/** 容量上限常量，供外部读取 */
	get maxEntries(): number {
		return MAX_ENTRIES;
	}

	/** 是否有未保存的变更 */
	get isDirty(): boolean {
		return this.dirty;
	}

	/**
	 * 清空所有日志
	 *
	 * 用于用户手动重置。更新 lastCleanup 以避免下次启动立即触发清理。
	 */
	async clear(): Promise<void> {
		this.entries = [];
		this.lastCleanup = Date.now();
		this.dirty = true;
		await this.save();
	}
}

/**
 * RuntimeLogger - 运行日志记录与清理服务。
 *
 * 作用：记录“发生了什么”（事件时间线），并持久化到插件目录下的 `runtime-log.json`。
 *
 * 与 `ErrorLogger` 的区别：
 * - RuntimeLogger：info/warn 事件（启动、索引、查询、配置变更等），偏“可观察性”
 * - ErrorLogger：错误诊断（异常、失败原因、堆栈等），偏“可排障性”
 *
 * 清理策略（与 ErrorLogger 类似）：
 * - 容量上限：MAX_ENTRIES（防止短时间内暴增导致文件过大）
 * - 时间过期：EXPIRY_MS（启动时懒清理，避免长期累积旧事件）
 */
import type { DataAdapter } from "obsidian";
import type { RuntimeLogEntry } from "../types";

/** runtime-log.json 的持久化格式。 */
interface RuntimeLogData {
	version: number;
	lastCleanup: number;
	entries: RuntimeLogEntry[];
}

/** 持久化结构版本号（用于未来演进与兼容）。 */
const CURRENT_VERSION = 1;
/** 容量上限：最多保留多少条运行日志。 */
const MAX_ENTRIES = 1000;
/** 时间过期：超过 14 天的运行日志会在启动时被清理。 */
const EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 运行日志记录器。
 *
 * 调用方式：
 * - `log()`：只写内存（快）
 * - `logAndSave()`：写内存 + 立即落盘（慢，但更稳妥）
 * - `save()`：在合适的时机批量落盘（例如 plugin unload）
 */
export class RuntimeLogger {
	/** 内存中的日志条目（按时间顺序追加）。 */
	private entries: RuntimeLogEntry[] = [];
	/** 上次执行过期清理的时间戳（ms since epoch）。 */
	private lastCleanup = 0;
	/** 是否存在未落盘的变更。 */
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
	 * 从磁盘加载运行日志。
	 *
	 * 首次使用时文件可能不存在；文件损坏也不应阻塞插件启动，因此这里采取 best-effort：
	 * - 成功：恢复 entries/lastCleanup
	 * - 失败：回退到空日志，并记录一条 warn 事件
	 */
	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.logPath)) {
				const raw = await this.adapter.read(this.logPath);
				const data = JSON.parse(raw) as RuntimeLogData;

				if (data.version === CURRENT_VERSION) {
					this.entries = data.entries || [];
					this.lastCleanup = data.lastCleanup || 0;
				}
			}
		} catch (err) {
			console.warn("RuntimeLogger: failed to load, starting fresh", err);
			this.entries = [];
			this.lastCleanup = 0;
			this.log({
				event: "runtime-log-load-failed",
				level: "warn",
				category: "storage",
				message: "加载持久化运行日志失败，将重新创建日志。",
				details: [
					`log_path=${this.logPath}`,
					`cause=${err instanceof Error ? err.message : String(err)}`,
				],
			});
		}
	}

	/**
	 * 将当前运行日志写入磁盘（runtime-log.json）。
	 *
	 * 为了便于用户查看，这里使用 `JSON.stringify(data, null, 2)` 进行格式化输出。
	 */
	async save(): Promise<void> {
		if (!this.dirty && this.entries.length === 0) {
			return;
		}

		const data: RuntimeLogData = {
			version: CURRENT_VERSION,
			lastCleanup: this.lastCleanup,
			entries: this.entries,
		};

		try {
			await this.adapter.write(this.logPath, JSON.stringify(data, null, 2));
			this.dirty = false;
		} catch (err) {
			console.error("RuntimeLogger: failed to save", err);
		}
	}

	/**
	 * 记录一条运行日志（仅写入内存）。
	 *
	 * 注意：该方法不会立刻落盘；调用方可在合适时机手动 `save()`，
	 * 或使用 `logAndSave()` 立即持久化。
	 */
	log(entry: Omit<RuntimeLogEntry, "timestamp">): void {
		this.entries.push({
			...entry,
			timestamp: Date.now(),
		});

		if (this.entries.length > MAX_ENTRIES) {
			const overflow = this.entries.length - MAX_ENTRIES;
			this.entries = this.entries.slice(overflow);
		}

		this.dirty = true;
	}

	/** 记录并立即持久化（适合需要“立刻可见”的关键事件）。 */
	async logAndSave(entry: Omit<RuntimeLogEntry, "timestamp">): Promise<void> {
		this.log(entry);
		await this.save();
	}

	/**
	 * 懒清理：删除过期的运行日志（默认 14 天）。
	 *
	 * 为了避免每次启动都遍历 entries，这里会基于 lastCleanup 做节流：
	 * - 距离上次清理不足 EXPIRY_MS：跳过
	 * - 否则：过滤掉过期条目并落盘
	 */
	async cleanupIfNeeded(): Promise<number> {
		const now = Date.now();
		if (this.lastCleanup > 0 && (now - this.lastCleanup) < EXPIRY_MS) {
			return 0;
		}

		const cutoff = now - EXPIRY_MS;
		const before = this.entries.length;
		this.entries = this.entries.filter((entry) => entry.timestamp >= cutoff);
		const removed = before - this.entries.length;

		this.lastCleanup = now;
		if (removed > 0 || before > 0) {
			this.dirty = true;
			await this.save();
			console.log(
				`RuntimeLogger: cleaned up ${removed} expired entries (${this.entries.length} remaining)`,
			);
		}

		return removed;
	}

	/** 获取最近的 N 条运行日志（用于 UI 展示/调试）。 */
	getRecent(count: number = 50): RuntimeLogEntry[] {
		return this.entries.slice(-count);
	}

	/** 当前日志条目总数。 */
	get size(): number {
		return this.entries.length;
	}

	/** 容量上限常量，供外部读取。 */
	get maxEntries(): number {
		return MAX_ENTRIES;
	}

	/** 是否有未保存的变更。 */
	get isDirty(): boolean {
		return this.dirty;
	}

	/** 清空所有运行日志并立即落盘。 */
	async clear(): Promise<void> {
		this.entries = [];
		this.lastCleanup = Date.now();
		this.dirty = true;
		await this.save();
	}
}

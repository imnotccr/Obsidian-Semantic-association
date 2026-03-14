/**
 * FailedTaskManager - 持久化记录可重试的索引失败文件
 *
 * 用途：
 * - 记录因为网络中断或 API 限流（429）导致索引失败的文件路径
 * - 提供一个持久化列表，允许用户在设置页手动“重试失败项”
 *
 * 存储位置（由 main.ts 注入）：
 * `{vault}/.obsidian/plugins/{pluginId}/failed-tasks.json`
 */

import type { DataAdapter } from "obsidian";
import { normalizeErrorDiagnostic } from "../utils/error-utils";

/**
 * failed-tasks.json 中的单条失败记录。
 *
 * 记录的核心目的是“可重试”：
 * - 用户可以在设置页点击“重试失败项”，把这些 path 重新加入索引队列/手动同步
 * - 同时保留 attempts / lastErrorCode / lastErrorStage，便于判断是否一直失败、失败发生在哪个阶段
 */
export type FailedTaskEntry = {
	/** 失败文件路径（vault 相对路径）。 */
	path: string;
	/** 已尝试次数（每次 markFailed +1）。 */
	attempts: number;
	/** 首次失败时间戳。 */
	firstFailedAt: number;
	/** 最近一次失败时间戳。 */
	lastFailedAt: number;
	/** 最近一次错误 code（来自 ErrorDiagnostic.code）。 */
	lastErrorCode?: string;
	/** 最近一次错误 stage（来自 ErrorDiagnostic.stage）。 */
	lastErrorStage?: string;
	/** 最近一次错误 message（来自 ErrorDiagnostic.message）。 */
	lastErrorMessage?: string;
};

interface FailedTaskData {
	version: number;
	tasks: Record<string, FailedTaskEntry>;
}

const CURRENT_VERSION = 1;

/**
 * FailedTaskManager - “可重试失败任务”的持久化管理器。
 *
 * 典型用法：
 * - ReindexService 在捕获到“可重试错误”（网络中断、429 限流等）时调用 `markFailed(path, error)`
 * - main.ts / 设置页在用户触发“重试失败项”时读取 `getAllPaths()` 并重新加入队列
 *
 * 设计要点：
 * - 内存态用 Map，提高查询/更新效率
 * - dirty 标记控制是否需要落盘，减少不必要 IO
 */
export class FailedTaskManager {
	private tasks: Map<string, FailedTaskEntry> = new Map();
	private dirty = false;

	constructor(
		private adapter: DataAdapter,
		private taskPath: string,
	) {}

	/**
	 * 从磁盘加载 failed-tasks.json。
	 *
	 * 兼容策略：
	 * - 文件不存在：静默返回（表示当前没有失败项）
	 * - JSON 损坏/结构不符：静默回退到空（不阻塞插件启动）
	 */
	async load(): Promise<void> {
		this.tasks.clear();
		this.dirty = false;

		try {
			if (!(await this.adapter.exists(this.taskPath))) {
				return;
			}

			const raw = await this.adapter.read(this.taskPath);
			const data = JSON.parse(raw) as FailedTaskData;
			if (data.version !== CURRENT_VERSION || !data.tasks) {
				return;
			}

			for (const [path, entry] of Object.entries(data.tasks)) {
				if (typeof path !== "string" || path.trim().length === 0) {
					continue;
				}
				if (!entry || typeof entry !== "object") {
					continue;
				}

				this.tasks.set(path, {
					path,
					attempts:
						typeof entry.attempts === "number" && Number.isInteger(entry.attempts) && entry.attempts > 0
							? entry.attempts
							: 1,
					firstFailedAt:
						typeof entry.firstFailedAt === "number" && Number.isFinite(entry.firstFailedAt) && entry.firstFailedAt > 0
							? entry.firstFailedAt
							: Date.now(),
					lastFailedAt:
						typeof entry.lastFailedAt === "number" && Number.isFinite(entry.lastFailedAt) && entry.lastFailedAt > 0
							? entry.lastFailedAt
							: Date.now(),
					lastErrorCode: typeof entry.lastErrorCode === "string" ? entry.lastErrorCode : undefined,
					lastErrorStage: typeof entry.lastErrorStage === "string" ? entry.lastErrorStage : undefined,
					lastErrorMessage: typeof entry.lastErrorMessage === "string" ? entry.lastErrorMessage : undefined,
				});
			}
		} catch (error) {
			console.warn("FailedTaskManager: failed to load, starting fresh", error);
			this.tasks.clear();
			this.dirty = false;
		}
	}

	/**
	 * 将当前失败任务写入磁盘（failed-tasks.json）。
	 *
	 * 只有 dirty 才会写入，避免频繁 IO。
	 */
	async save(): Promise<void> {
		if (!this.dirty) {
			return;
		}

		const tasks: Record<string, FailedTaskEntry> = {};
		for (const [path, entry] of this.tasks) {
			tasks[path] = entry;
		}

		const data: FailedTaskData = {
			version: CURRENT_VERSION,
			tasks,
		};

		try {
			await this.adapter.write(this.taskPath, JSON.stringify(data, null, 2));
			this.dirty = false;
		} catch (error) {
			console.error("FailedTaskManager: failed to save", error);
		}
	}

	/**
	 * 标记某个 path 的索引任务失败（并更新尝试次数/最后错误信息）。
	 *
	 * @returns 是否成功写入（path 为空会返回 false）。
	 */
	markFailed(path: string, error: unknown): boolean {
		const normalized = path.trim();
		if (!normalized) {
			return false;
		}

		const now = Date.now();
		const diagnostic = normalizeErrorDiagnostic(error);
		const existing = this.tasks.get(normalized);

		if (existing) {
			existing.attempts += 1;
			existing.lastFailedAt = now;
			existing.lastErrorCode = diagnostic.code;
			existing.lastErrorStage = diagnostic.stage;
			existing.lastErrorMessage = diagnostic.message;
			this.dirty = true;
			return true;
		}

		this.tasks.set(normalized, {
			path: normalized,
			attempts: 1,
			firstFailedAt: now,
			lastFailedAt: now,
			lastErrorCode: diagnostic.code,
			lastErrorStage: diagnostic.stage,
			lastErrorMessage: diagnostic.message,
		});
		this.dirty = true;
		return true;
	}

	/**
	 * 标记某个 path 已成功（或无需再重试），从失败列表中移除。
	 * @returns 是否确实删除了一个条目。
	 */
	resolve(path: string): boolean {
		const normalized = path.trim();
		if (!normalized) {
			return false;
		}

		const deleted = this.tasks.delete(normalized);
		if (deleted) {
			this.dirty = true;
		}
		return deleted;
	}

	/**
	 * 处理 rename：把 oldPath 对应的失败记录迁移到 newPath。
	 * @returns 是否迁移成功。
	 */
	rename(oldPath: string, newPath: string): boolean {
		const oldKey = oldPath.trim();
		const newKey = newPath.trim();
		if (!oldKey || !newKey || oldKey === newKey) {
			return false;
		}

		const entry = this.tasks.get(oldKey);
		if (!entry) {
			return false;
		}

		this.tasks.delete(oldKey);
		entry.path = newKey;
		this.tasks.set(newKey, entry);
		this.dirty = true;
		return true;
	}

	/** 获取所有失败文件路径（用于“重试失败项”）。 */
	getAllPaths(): string[] {
		return Array.from(this.tasks.keys());
	}

	/** 当前失败项数量。 */
	get size(): number {
		return this.tasks.size;
	}

	/** 是否存在未落盘的变更。 */
	get isDirty(): boolean {
		return this.dirty;
	}

	/** 清空所有失败项并落盘。 */
	async clear(): Promise<void> {
		this.tasks.clear();
		this.dirty = true;
		await this.save();
	}
}

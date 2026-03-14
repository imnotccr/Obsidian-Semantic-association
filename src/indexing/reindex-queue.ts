/**
 * ReindexQueue - 索引任务防抖去重队列
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Indexing Layer（索引层）                     │
 * │  被谁调用：main.ts（文件事件处理）                            │
 * │  调用谁：ReindexService.processTask()（通过 executor）        │
 * │  参见：docs/ARCHITECTURE.md「五、索引流程 → 5.2 增量索引」    │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 这是文件事件和实际索引之间的「缓冲层」。
 *
 * ## 为什么需要队列
 *
 * 想象用户正在快速编辑一篇笔记：每次按键都会触发 vault.on('modify')。
 * 如果每次 modify 都立即执行索引（读取→切分→embedding→存储），
 * 会造成：
 * - 大量无意义的重复索引（1 秒内可能触发 10+ 次 modify）
 * - embedding API 调用浪费
 * - UI 卡顿
 *
 * 队列通过三个机制解决这个问题：
 *
 * ### 1. 防抖（Debounce）
 * 用户停止编辑 1000ms 后才执行索引。
 * 每次新事件重置计时器，连续编辑只触发一次索引。
 *
 * ### 2. 去重（Deduplication）
 * 同一文件的多次事件只保留最新一条。
 * 例如 modify→modify→modify 只执行最后一次。
 *
 * ### 3. 串行化（Serialization）
 * 同一时刻只执行一个索引任务。
 * 避免两个任务同时写入 NoteStore/ChunkStore 导致数据不一致。
 *
 * ## 事件流时序图
 *
 * ```
 * 时间轴：
 * t0   用户编辑 → modify 事件 → enqueue(modify, "a.md") → 计时器启动（1000ms）
 * t200 用户继续编辑 → modify → enqueue(modify, "a.md") → 计时器重置
 * t500 用户继续编辑 → modify → enqueue(modify, "a.md") → 计时器重置
 * t800 用户停止编辑
 * t1800（t800 + 1000ms）→ flush() → 执行 processTask({ type: "modify", path: "a.md" })
 *
 * 结果：3 次 modify 事件只触发 1 次索引
 * ```
 *
 * ## DIP 原则
 *
 * 队列不直接 import ReindexService，而是通过 setExecutor() 注入回调。
 * 这样队列是一个纯粹的调度器，不耦合具体的索引实现。
 */

/** 索引任务类型，对应 Obsidian 的四种文件事件 */
export type IndexTaskType = "create" | "modify" | "delete" | "rename";

/** 单个索引任务 */
export interface IndexTask {
	type: IndexTaskType;
	/** 文件路径。rename 事件时为新路径 */
	path: string;
	/** 仅 rename 事件使用：重命名前的旧路径 */
	oldPath?: string;
}

/**
 * 任务执行器的函数签名
 *
 * 实际实现是 ReindexService.processTask()，
 * 但队列不知道也不关心这一点（DIP）。
 */
type TaskExecutor = (task: IndexTask) => Promise<void>;

/**
 * 批次级别的生命周期回调
 *
 * 每次 flush() 处理一批任务时触发：
 * - onFlushStart：批次开始时，携带本次任务数量
 * - onFlushEnd：批次结束时，携带成功/失败数量
 *
 * 用于 main.ts 驱动状态栏和完成 Notice。
 */
export type FlushCallbacks = {
	onFlushStart?: (taskCount: number) => void;
	onFlushEnd?: (succeeded: number, failed: number) => void;
};

/**
 * 防抖延迟（ms）
 *
 * 1000ms 是一个平衡点：
 * - 太短（如 200ms）：用户打字间隙就可能触发，防抖效果差
 * - 太长（如 5000ms）：用户修改后等太久才能看到索引更新
 */
const DEBOUNCE_DELAY = 1000;

export class ReindexQueue {
	/**
	 * 待执行任务池：path → IndexTask
	 *
	 * 使用 path 作为 key 实现去重：
	 * 同一文件的多次事件，后来的会覆盖前面的。
	 * 例如对同一文件先 modify 再 delete，最终只执行 delete。
	 */
	private pending: Map<string, IndexTask> = new Map();

	/** 是否正在执行任务（串行化控制标志） */
	private processing = false;

	/** 防抖定时器句柄 */
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** 任务执行器（由外部通过 setExecutor 注入） */
	private executor: TaskExecutor | null = null;

	/** 批次回调（由外部通过 setFlushCallbacks 注入） */
	private flushCallbacks: FlushCallbacks = {};

	constructor(private debounceDelay: number = DEBOUNCE_DELAY) {}

	/**
	 * 注册任务执行器
	 *
	 * 在 main.ts 的 createServices() 中调用：
	 *   reindexQueue.setExecutor((task) => reindexService.processTask(task))
	 */
	setExecutor(executor: TaskExecutor): void {
		this.executor = executor;
	}

	/**
	 * 注册批次生命周期回调
	 *
	 * 在 main.ts 的 createServices() 中调用，用于驱动状态栏和完成 Notice。
	 */
	setFlushCallbacks(callbacks: FlushCallbacks): void {
		this.flushCallbacks = callbacks;
	}

	/**
	 * 提交一个索引任务
	 *
	 * 这是外部调用队列的唯一入口。典型调用：
	 *   vault.on('modify', (file) => queue.enqueue({ type: 'modify', path: file.path }))
	 *
	 * 每次 enqueue 都会：
	 * 1. 将任务写入 pending Map（覆盖同路径的旧任务 = 去重）
	 * 2. 重置防抖计时器（重新开始倒计时）
	 */
	enqueue(task: IndexTask): void {
		this.pending.set(this.getTaskKey(task), task);
		this.resetDebounce();
	}

	/**
	 * 立即执行当前队列中的任务（跳过防抖延迟）
	 *
	 * 主要用于设置页的“重试失败项”等手动触发场景。
	 */
	async flushNow(): Promise<void> {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		await this.flush();
	}

	/** 当前待执行的任务数量 */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** 是否正在处理任务 */
	get isProcessing(): boolean {
		return this.processing;
	}

	/**
	 * 清空队列
	 *
	 * 在插件卸载（onunload）时调用，取消待执行的任务和定时器，
	 * 避免插件卸载后仍有回调尝试执行。
	 */
	clear(): void {
		this.pending.clear();
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	/**
	 * 重置防抖计时器
	 *
	 * 每次 enqueue 时调用。逻辑：
	 * - 如果已有定时器 → 取消它（旧的倒计时作废）
	 * - 启动新的定时器 → debounceDelay 毫秒后执行 flush
	 *
	 * 效果：只要用户持续触发事件，计时器就不断重置，
	 * 直到用户停下来超过 debounceDelay 毫秒，才真正执行。
	 */
	private resetDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.flush();
		}, this.debounceDelay);
	}

	/**
	 * 执行所有累积的任务
	 *
	 * 防抖计时器到期后触发。流程：
	 *
	 * 1. 检查前置条件（是否正在处理、是否有任务、是否有执行器）
	 * 2. 设置 processing = true（加锁，防止并发）
	 * 3. 取出所有待执行任务并清空 pending（快照语义）
	 * 4. 逐个串行执行，单个任务失败不影响其他任务
	 * 5. 释放锁（processing = false）
	 * 6. 检查执行期间是否有新任务入队，如有则重新启动防抖
	 *
	 * 为什么串行而非并行？
	 * - 多个任务可能操作同一个 Store（如 A.md 和引用 A.md 的 B.md）
	 * - 并行执行可能导致读取到中间状态
	 * - 串行执行简单可靠，v1 的任务量不需要并行优化
	 */
	private async flush(): Promise<void> {
		// 防止并发执行
		if (this.processing || this.pending.size === 0) return;
		if (!this.executor) {
			console.warn("ReindexQueue: no executor registered");
			return;
		}

		this.processing = true;

		// 快照：取出当前所有任务并清空队列
		// 这样执行期间新入队的任务不会被本次 flush 处理，
		// 而是等下一轮防抖后再处理
		const tasks = Array.from(this.pending.values());
		this.pending.clear();

		this.flushCallbacks.onFlushStart?.(tasks.length);

		let failedCount = 0;
		try {
			// 串行执行每个任务
			for (const task of tasks) {
				try {
					await this.executor(task);
				} catch (err) {
					// 单个任务失败不阻塞其他任务
					failedCount++;
					console.error(`ReindexQueue: failed to process task [${task.type}] ${task.path}`, err);
				}
			}
		} finally {
			// 无论成功失败都要释放锁
			this.processing = false;

			try {
				this.flushCallbacks.onFlushEnd?.(tasks.length - failedCount, failedCount);
			} catch (err) {
				console.error("ReindexQueue: onFlushEnd callback threw", err);
			}

			// 执行期间可能有新任务入队（如用户在索引过程中又编辑了文件），
			// 需要再次启动防抖来处理这些新任务
			if (this.pending.size > 0) {
				this.resetDebounce();
			}
		}
	}

	private getTaskKey(task: IndexTask): string {
		if (task.type === "rename") {
			return `rename:${task.oldPath ?? ""}->${task.path}`;
		}
		return `path:${task.path}`;
	}
}

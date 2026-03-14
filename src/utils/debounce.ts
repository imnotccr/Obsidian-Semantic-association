/**
 * 防抖函数
 *
 * 在最后一次调用后等待指定延迟，才执行目标函数。
 * 用于搜索输入、文件变更等高频事件的节流。
 *
 * @param fn    - 目标函数
 * @param delay - 延迟毫秒数
 * @returns 防抖包装后的函数（带 `cancel()` 方法）
 *
 * 为什么要提供 `cancel()`？
 * - View/组件关闭时可能仍有未触发的 timer
 * - timer 触发后回调访问已销毁的 DOM/状态，会导致异常或“幽灵刷新”
 * - `cancel()` 允许调用方在 onClose/onunload 时主动清理
 */
export type DebouncedFn<T extends (...args: any[]) => any> = ((...args: Parameters<T>) => void) & {
	cancel: () => void;
};

export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): DebouncedFn<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	const wrapped = ((...args: Parameters<T>) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, delay);
	}) as DebouncedFn<T>;

	wrapped.cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	return wrapped;
}

/**
 * 错误处理工具集（Error Utils）。
 *
 * 在插件的各个模块里，`catch (error)` 拿到的值可能是：
 * - `string`
 * - 标准 `Error`
 * - 任意 object（例如某些库/HTTP 客户端抛出的结构化对象）
 *
 * 本文件做两件核心事情：
 * 1) `normalizeErrorDiagnostic()`：把“任意 error 值”标准化成 `ErrorDiagnostic`，方便写日志/展示给用户
 * 2) `mergeErrorDetails()`：把多组 details 合并并去重，避免日志信息缺失或重复
 *
 * 另外还提供“反向”能力：
 * - `createErrorFromDiagnostic()`：从诊断信息重新构造一个 Error（用于把错误在层间传递）
 * - `applyErrorDiagnostic()`：把 code/stage/details 等非标准字段挂到 Error 上（best-effort）
 */
import type { ErrorDiagnostic } from "../types";

type DiagnosticCarrier = Error & {
	code?: unknown;
	stage?: unknown;
	details?: unknown;
	diagnostic?: unknown;
};

/** 判断一个值是否为非 null 的 object（用于安全访问属性）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * 把任意值尽量转成“可读字符串”：
 * - string：去掉全空白后返回
 * - number/boolean：转成 string
 * - 其它：返回 undefined（交给上层决定如何兜底）
 */
const toOptionalString = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
};

/**
 * 把一个 unknown 值规范化成 string[]（如果它本身不是数组则返回 undefined）。
 * 用于容错读取 error.details / diagnostic.details。
 */
const toStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const normalized = value
		.map((item) => toOptionalString(item))
		.filter((item): item is string => Boolean(item));
	return normalized.length > 0 ? normalized : undefined;
};

/** JSON.stringify 的安全包装：序列化失败时回退到 String(value)。 */
const stringifyRecord = (value: Record<string, unknown>): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

/**
 * 合并多个 details 数组，并去重。
 *
 * 日志里 details 往往由不同层贡献：例如
 * - 调用方提供：operation=xxx、filePath=...
 * - HTTP 层提供：status=429、retry-after=...
 * - normalizeErrorDiagnostic 提供：error.code、error.stage...
 *
 * 统一合并后写入日志，能最大化保留上下文。
 */
export const mergeErrorDetails = (
	...detailGroups: Array<string[] | undefined>
): string[] | undefined => {
	const merged: string[] = [];
	for (const group of detailGroups) {
		if (!group) {
			continue;
		}
		for (const item of group) {
			if (!merged.includes(item)) {
				merged.push(item);
			}
		}
	}
	return merged.length > 0 ? merged : undefined;
};

/**
 * 把任意 thrown 值标准化成 `ErrorDiagnostic`。
 *
 * 兼容策略：
 * - 如果 error 是 string：直接当 message
 * - 如果 error 是 Error：提取 message/name/stack，并尝试读取扩展字段（code/stage/details/diagnostic）
 * - 如果 error 是 object：尽量读取同名字段；读取不到则 stringify
 */
export const normalizeErrorDiagnostic = (error: unknown): ErrorDiagnostic => {
	if (typeof error === "string") {
		return { message: error };
	}

	if (error instanceof Error) {
		const carrier = error as DiagnosticCarrier;
		const nested = isRecord(carrier.diagnostic) ? carrier.diagnostic : undefined;
		return {
			message:
				toOptionalString(nested?.message) ??
				toOptionalString(error.message) ??
				String(error),
			name:
				toOptionalString(nested?.name) ??
				toOptionalString(error.name) ??
				undefined,
			code:
				toOptionalString(nested?.code) ??
				toOptionalString(carrier.code) ??
				undefined,
			stage:
				toOptionalString(nested?.stage) ??
				toOptionalString(carrier.stage) ??
				undefined,
			stack:
				toOptionalString(nested?.stack) ??
				toOptionalString(error.stack) ??
				undefined,
			details: mergeErrorDetails(
				toStringArray(nested?.details),
				toStringArray(carrier.details),
			),
		};
	}

	if (isRecord(error)) {
		const nested = isRecord(error.diagnostic) ? error.diagnostic : undefined;
		return {
			message:
				toOptionalString(nested?.message) ??
				toOptionalString(error.message) ??
				stringifyRecord(error),
			name:
				toOptionalString(nested?.name) ??
				toOptionalString(error.name) ??
				undefined,
			code:
				toOptionalString(nested?.code) ??
				toOptionalString(error.code) ??
				undefined,
			stage:
				toOptionalString(nested?.stage) ??
				toOptionalString(error.stage) ??
				undefined,
			stack:
				toOptionalString(nested?.stack) ??
				toOptionalString(error.stack) ??
				undefined,
			details: mergeErrorDetails(
				toStringArray(nested?.details),
				toStringArray(error.details),
			),
		};
	}

	return { message: String(error) };
};

/**
 * 从诊断信息构造一个 Error。
 *
 * 注意：JS 的 Error 标准字段只有 message/name/stack。
 * code/stage/details 这类字段属于扩展字段，会通过 `applyErrorDiagnostic()` best-effort 挂载。
 */
export const createErrorFromDiagnostic = (diagnostic: ErrorDiagnostic): Error => {
	const error = new Error(diagnostic.message);
	if (diagnostic.name) {
		error.name = diagnostic.name;
	}
	if (diagnostic.stack) {
		error.stack = diagnostic.stack;
	}
	return applyErrorDiagnostic(error, diagnostic);
};

/**
 * 把诊断信息（除 message 外）写回到 Error 上。
 *
 * 这允许我们在“只接受 Error”的 API 场景中，把更多上下文一起带过去。
 * 例如上层 catch 到 Error 后，仍可读取 carrier.code/carrier.stage/carrier.details。
 */
export const applyErrorDiagnostic = (
	error: Error,
	diagnostic: Omit<ErrorDiagnostic, "message">,
): Error => {
	const carrier = error as DiagnosticCarrier;
	if (diagnostic.name) {
		error.name = diagnostic.name;
	}
	if (diagnostic.stack) {
		error.stack = diagnostic.stack;
	}
	if (diagnostic.code) {
		carrier.code = diagnostic.code;
	}
	if (diagnostic.stage) {
		carrier.stage = diagnostic.stage;
	}
	if (diagnostic.details && diagnostic.details.length > 0) {
		carrier.details = diagnostic.details;
	}
	return error;
};

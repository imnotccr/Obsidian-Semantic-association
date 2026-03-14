/**
 * Chunker - Markdown 笔记切分器（Chunking）。
 *
 * 目标：把一篇笔记的正文切成多个“语义片段”（ChunkMeta），用于 embeddings：
 * - chunk 过短：上下文太少，相似度分数更不稳定/更噪声
 * - chunk 过长：主题被稀释，且命中后难以定位到具体段落
 *
 * 本实现的关键点：
 * 1) 处理 YAML frontmatter：frontmatter 不参与切分/向量化，但需要正确计算行号偏移
 * 2) 按 Markdown headings 切 section：用“标题路径”作为 chunk 的语义上下文（heading 字段）
 * 3) section 内按“块（block）”切分：空行分隔段落；但 fenced code block 内不以空行切分
 * 4) 块过长时再做软切分：优先在换行/句号/逗号/空格等边界处切，尽量保持语义自然
 * 5) overlap：给相邻 chunk 增加一小段重叠文本，减少切分边界导致的语义断裂
 *
 * 输出：
 * - `ChunkMeta.chunkId` 形如 `${notePath}#${order}`
 * - `ChunkMeta.range` 记录 0-based 行号范围，用于从结果点击时跳转并高亮
 */
import type { ChunkMeta } from "../types";

/** 纯文本片段 + 它在原文中的行号范围（用于后续映射到 ChunkMeta.range）。 */
type TextSpan = {
	text: string;
	startLine: number;
	endLine: number;
};

/** 一个 heading section：heading 上下文 + 该 section 的正文行。 */
type Section = {
	heading: string;
	lines: string[];
	startLine: number;
};

// Chunk sizes are tuned for embedding-based semantic retrieval:
// - Too small → sparse context, similarity scores tend to be unstable/noisy.
// - Too large → topic dilution and harder passage localization.
// Target: ~300–800 chars per chunk by default (good for BGE-M3 local semantics).
// Add 20% overlap to prevent semantic breaks at cut boundaries.
const MIN_CHUNK_LENGTH = 300;
const MAX_CHUNK_LENGTH = 800;
const CHUNK_OVERLAP_RATIO = 0.2;
const CHUNK_OVERLAP_LENGTH = Math.floor(MAX_CHUNK_LENGTH * CHUNK_OVERLAP_RATIO);
// Build "base" chunks first, then prepend overlap from the previous chunk.
const BASE_MAX_CHUNK_LENGTH = Math.max(MIN_CHUNK_LENGTH, MAX_CHUNK_LENGTH - CHUNK_OVERLAP_LENGTH);
const SOFT_SPLIT_FLOOR = Math.max(MIN_CHUNK_LENGTH, Math.floor(BASE_MAX_CHUNK_LENGTH * 0.6));
const SENTENCE_BOUNDARIES = ".!?;\u3002\uFF01\uFF1F\uFF1B";
const CLAUSE_BOUNDARIES = ",:\uFF0C\u3001\uFF1A";

export class Chunker {
	/**
	 * 将笔记内容切分成 chunk。
	 *
	 * @param notePath - 笔记路径（用于生成 chunkId）
	 * @param content  - 原始 Markdown 文本
	 */
	chunk(notePath: string, content: string): ChunkMeta[] {
		const normalizedContent = this.normalizeLineEndings(content);
		const { body, bodyStartLine } = this.stripFrontmatterWithOffset(normalizedContent);
		if (!body.trim()) {
			return [];
		}

		const sections = this.splitByHeadings(body, bodyStartLine);
		const chunks: ChunkMeta[] = [];
		let order = 0;

		for (const section of sections) {
			const sectionChunks = this.buildSectionChunks(section);
			for (const span of sectionChunks) {
				const trimmedText = span.text.trim();
				if (!trimmedText) {
					continue;
				}

				chunks.push({
					chunkId: `${notePath}#${order}`,
					notePath,
					heading: section.heading,
					text: trimmedText,
					order,
					range: [span.startLine, span.endLine],
				});
				order++;
			}
		}

		return chunks;
	}

	/** 统一换行符：把 CRLF/CR 规范化成 LF，避免行号计算与分割逻辑出错。 */
	private normalizeLineEndings(content: string): string {
		return content.replace(/\r\n?/g, "\n");
	}

	/**
	 * 去掉 YAML frontmatter，并返回“正文起始行”的偏移量。
	 *
	 * 为什么要返回 bodyStartLine？
	 * - chunk 需要记录 `range`（0-based 行号）
	 * - 去掉 frontmatter 后，正文的第 0 行在原文里可能是第 N 行
	 * - 后续所有行号计算都需要加上这个偏移量，才能与编辑器的真实行号对齐
	 */
	private stripFrontmatterWithOffset(content: string): { body: string; bodyStartLine: number } {
		const match = content.match(/^---\n[\s\S]*?\n(?:---|\.\.\.)\n*/);
		if (!match) {
			return { body: content, bodyStartLine: 0 };
		}

		const frontmatter = match[0];
		return {
			body: content.slice(frontmatter.length),
			bodyStartLine: this.countNewlines(frontmatter),
		};
	}

	/**
	 * 按 Markdown headings 把正文切成多个 section。
	 *
	 * 规则：
	 * - `#` ~ `######` 作为 heading
	 * - heading 会维护一个 stack，形成类似 “H1 / H2 / H3” 的路径上下文
	 * - fenced code block 内不识别 heading（避免代码里的 `#` 被误判）
	 */
	private splitByHeadings(content: string, bodyStartLine: number): Section[] {
		const sections: Section[] = [];
		const lines = content.split("\n");
		const headingStack: string[] = [];
		let currentHeading = "";
		let currentLines: string[] = [];
		let currentStartLine: number | null = null;
		let activeFenceMarker: string | null = null;

		const flushSection = (): void => {
			if (currentLines.length === 0 || currentStartLine === null) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const { startIndex, endIndex } = this.trimLineIndices(currentLines);
			if (startIndex > endIndex) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const slicedLines = currentLines.slice(startIndex, endIndex + 1);
			const text = slicedLines.join("\n").trim();
			if (!text) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			sections.push({
				heading: currentHeading,
				lines: slicedLines,
				startLine: currentStartLine + startIndex,
			});
			currentLines = [];
			currentStartLine = null;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const absoluteLine = bodyStartLine + index;
			if (!activeFenceMarker) {
				const headingMatch = this.matchHeading(line);
				if (headingMatch) {
					flushSection();
					headingStack[headingMatch.level - 1] = headingMatch.text;
					headingStack.length = headingMatch.level;
					currentHeading = headingStack.join(" / ");
					continue;
				}
			}

			if (currentLines.length === 0) {
				currentStartLine = absoluteLine;
			}
			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushSection();

		if (sections.length > 0) {
			return sections;
		}

		const { startIndex, endIndex } = this.trimLineIndices(lines);
		if (startIndex > endIndex) {
			return [];
		}

		return [
			{
				heading: "",
				lines: lines.slice(startIndex, endIndex + 1),
				startLine: bodyStartLine + startIndex,
			},
		];
	}

	/**
	 * 将一个 section 进一步构造成多个 chunk 文本片段。
	 *
	 * 思路：
	 * - 先按空行等规则切成 block（段落/代码块等）
	 * - block 过长时再拆成更小的 fragment
	 * - 再把 fragment 合并成接近目标长度的 chunk
	 * - 最后给 chunk 加 overlap（减少边界断裂）
	 */
	private buildSectionChunks(section: Section): TextSpan[] {
		const blocks = this.splitIntoBlocks(section);
		if (blocks.length === 0) {
			return [];
		}

		const chunks: TextSpan[] = [];
		let currentText = "";
		let currentStartLine = 0;
		let currentEndLine = 0;

		const flushCurrent = (): void => {
			const trimmed = currentText.trim();
			if (trimmed) {
				chunks.push({
					text: trimmed,
					startLine: currentStartLine,
					endLine: currentEndLine,
				});
			}
			currentText = "";
		};

		for (const block of blocks) {
			const fragments = this.splitOversizedSpan(block);
			for (const fragment of fragments) {
				if (!currentText) {
					currentText = fragment.text;
					currentStartLine = fragment.startLine;
					currentEndLine = fragment.endLine;
					continue;
				}

				const merged = `${currentText}\n\n${fragment.text}`;
				const maxLength = chunks.length === 0 ? MAX_CHUNK_LENGTH : BASE_MAX_CHUNK_LENGTH;
				if (merged.length <= maxLength) {
					currentText = merged;
					currentEndLine = fragment.endLine;
					continue;
				}

				flushCurrent();
				currentText = fragment.text;
				currentStartLine = fragment.startLine;
				currentEndLine = fragment.endLine;
			}
		}

		if (currentText) {
			const trimmed = currentText.trim();
			const previous = chunks[chunks.length - 1];
			const maxLength = chunks.length === 1 ? MAX_CHUNK_LENGTH : BASE_MAX_CHUNK_LENGTH;
			if (
				trimmed.length < MIN_CHUNK_LENGTH &&
				previous &&
				`${previous.text}\n\n${trimmed}`.length <= maxLength
			) {
				previous.text = `${previous.text}\n\n${trimmed}`;
				previous.endLine = currentEndLine;
			} else {
				flushCurrent();
			}
		}

		const output = chunks.filter((chunk) => chunk.text.trim().length > 0);
		return this.applyOverlap(output);
	}

	/**
	 * 为相邻 chunk 添加重叠文本（overlap）。
	 *
	 * 目的：避免一个语义单位刚好被切在边界处，导致“上半句在 chunkA，下半句在 chunkB”，
	 * 查询时两个 chunk 都不够匹配。
	 *
	 * 实现：从上一个 chunk 的尾部截取固定长度的文本，拼到当前 chunk 头部。
	 * 同时会根据 overlapText 中的换行数量回推 overlapStartLine，保持 range 尽量准确。
	 */
	private applyOverlap(chunks: TextSpan[]): TextSpan[] {
		if (CHUNK_OVERLAP_LENGTH <= 0 || chunks.length <= 1) {
			return chunks;
		}

		const output: TextSpan[] = [chunks[0]];
		for (let index = 1; index < chunks.length; index++) {
			const previous = output[output.length - 1];
			const current = chunks[index];

			const source = previous.text;
			const overlapText =
				source.length <= CHUNK_OVERLAP_LENGTH
					? source
					: source.slice(source.length - CHUNK_OVERLAP_LENGTH);
			const overlapStartLine = Math.max(
				previous.startLine,
				previous.endLine - this.countNewlines(overlapText),
			);

			output.push({
				text: overlapText + current.text,
				startLine: overlapStartLine,
				endLine: current.endLine,
			});
		}

		return output;
	}

	/**
	 * 把 section 切成 block：
	 * - 普通文本：以空行作为段落分隔
	 * - fenced code block：在代码块内不以空行分隔（保证代码块整体性）
	 */
	private splitIntoBlocks(section: Section): TextSpan[] {
		const blocks: TextSpan[] = [];
		const lines = section.lines;
		let currentLines: string[] = [];
		let currentStartLine: number | null = null;
		let activeFenceMarker: string | null = null;

		const flushBlock = (): void => {
			if (currentLines.length === 0 || currentStartLine === null) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const { startIndex, endIndex } = this.trimLineIndices(currentLines);
			if (startIndex > endIndex) {
				currentLines = [];
				currentStartLine = null;
				return;
			}

			const slicedLines = currentLines.slice(startIndex, endIndex + 1);
			const text = slicedLines.join("\n").trim();
			if (text) {
				blocks.push({
					text,
					startLine: currentStartLine + startIndex,
					endLine: currentStartLine + endIndex,
				});
			}
			currentLines = [];
			currentStartLine = null;
		};

		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const absoluteLine = section.startLine + index;
			if (!activeFenceMarker && line.trim().length === 0) {
				flushBlock();
				continue;
			}

			if (currentLines.length === 0) {
				currentStartLine = absoluteLine;
			}
			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushBlock();
		return blocks;
	}

	/**
	 * 处理“过长的 span”：把它拆成不超过 BASE_MAX_CHUNK_LENGTH 的多个片段。
	 *
	 * 拆分策略：
	 * - 优先在换行/句号/逗号/空白处拆（更自然）
	 * - 如果找不到合适边界，则硬切（fallback）
	 * - 同时维护行号：根据拆分片段中的换行数推进 startLine
	 */
	private splitOversizedSpan(span: TextSpan): TextSpan[] {
		const trimmedSpan = this.trimSpan(span);
		if (!trimmedSpan) {
			return [];
		}
		if (trimmedSpan.text.length <= BASE_MAX_CHUNK_LENGTH) {
			return [trimmedSpan];
		}

		const fragments: TextSpan[] = [];
		let remaining = trimmedSpan.text;
		let remainingStartLine = trimmedSpan.startLine;

		while (remaining.length > BASE_MAX_CHUNK_LENGTH) {
			const splitPoint = this.findSplitPoint(remaining, BASE_MAX_CHUNK_LENGTH);
			const rawSlice = remaining.slice(0, splitPoint);
			const fragment = rawSlice.trim();

			if (!fragment) {
				const fallbackRaw = remaining.slice(0, BASE_MAX_CHUNK_LENGTH);
				const fallback = fallbackRaw.trim();
				if (fallback) {
					fragments.push({
						text: fallback,
						...this.computeTrimmedRange(remainingStartLine, fallbackRaw),
					});
				}

				const rawRemaining = remaining.slice(BASE_MAX_CHUNK_LENGTH);
				const baseStartLine = remainingStartLine + this.countNewlines(fallbackRaw);
				const trimmedRemaining = this.trimStartWithLineOffset(
					rawRemaining,
					baseStartLine,
				);
				remaining = trimmedRemaining.text;
				remainingStartLine = trimmedRemaining.startLine;
				continue;
			}

			fragments.push({
				text: fragment,
				...this.computeTrimmedRange(remainingStartLine, rawSlice),
			});

			const rawRemaining = remaining.slice(splitPoint);
			const baseStartLine = remainingStartLine + this.countNewlines(rawSlice);
			const trimmedRemaining = this.trimStartWithLineOffset(rawRemaining, baseStartLine);
			remaining = trimmedRemaining.text;
			remainingStartLine = trimmedRemaining.startLine;
		}

		if (remaining) {
			const finalText = remaining.trim();
			if (finalText) {
				fragments.push({
					text: finalText,
					...this.computeTrimmedRange(remainingStartLine, remaining),
				});
			}
		}

		return fragments.filter((fragment) => fragment.text.length > 0);
	}

	/**
	 * 在 [floor, limit] 区间内寻找一个“尽量自然”的切分点。
	 *
	 * 首选边界：
	 * 1) 换行
	 * 2) 句子边界（中英文句号/问号/分号等）
	 * 3) 从句边界（逗号/冒号等）
	 * 4) 空格/制表符
	 *
	 * 如果在 soft floor 内找不到，再放宽到 0。
	 */
	private findSplitPoint(text: string, limit: number): number {
		const preferredBoundaries = ["\n", SENTENCE_BOUNDARIES, CLAUSE_BOUNDARIES, " \t"];
		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, SOFT_SPLIT_FLOOR);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		for (const boundaryChars of preferredBoundaries) {
			const splitPoint = this.findLastBoundary(text, limit, boundaryChars, 0);
			if (splitPoint > 0) {
				return splitPoint;
			}
		}

		return Math.min(limit, text.length);
	}

	private findLastBoundary(
		text: string,
		limit: number,
		boundaryChars: string,
		floor: number,
	): number {
		const start = Math.min(limit, text.length - 1);
		for (let index = start; index >= floor; index--) {
			if (boundaryChars.includes(text[index])) {
				return index + 1;
			}
		}
		return -1;
	}

	/** 匹配 Markdown ATX heading（# ~ ######）。 */
	private matchHeading(line: string): { level: number; text: string } | null {
		const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		if (!match) {
			return null;
		}

		const text = match[2].trim();
		if (!text) {
			return null;
		}

		return {
			level: match[1].length,
			text,
		};
	}

	/**
	 * fenced code block 状态机：
	 * - 遇到 ``` 或 ~~~ 开始 fence
	 * - 再次遇到相同类型的 fence 结束
	 */
	private updateFenceMarker(line: string, activeMarker: string | null): string | null {
		const trimmed = line.trimStart();
		const fenceMatch = trimmed.match(/^(```+|~~~+)/);
		if (!fenceMatch) {
			return activeMarker;
		}

		const marker = fenceMatch[1];
		if (!activeMarker) {
			return marker;
		}

		return marker.startsWith(activeMarker[0]) ? null : activeMarker;
	}

	/** 计算一组行中首尾的非空白范围（用于 trim）。 */
	private trimLineIndices(lines: string[]): { startIndex: number; endIndex: number } {
		let startIndex = 0;
		while (startIndex < lines.length && lines[startIndex].trim().length === 0) {
			startIndex++;
		}

		let endIndex = lines.length - 1;
		while (endIndex >= startIndex && lines[endIndex].trim().length === 0) {
			endIndex--;
		}

		return { startIndex, endIndex };
	}

	/** 统计字符串中的换行数量（用于行号推进）。 */
	private countNewlines(text: string): number {
		let count = 0;
		for (let index = 0; index < text.length; index++) {
			if (text[index] === "\n") {
				count++;
			}
		}
		return count;
	}

	/**
	 * trim 一个 TextSpan，并把 trim 掉的换行数反映到 startLine/endLine 上。
	 * 这样后续 range 映射更接近真实位置。
	 */
	private trimSpan(span: TextSpan): TextSpan | null {
		const trimmedText = span.text.trim();
		if (!trimmedText) {
			return null;
		}

		const trimStartText = span.text.trimStart();
		const leadingRemoved = span.text.slice(0, span.text.length - trimStartText.length);
		const leadingNewlines = this.countNewlines(leadingRemoved);

		const trimEndText = span.text.trimEnd();
		const trailingRemoved = span.text.slice(trimEndText.length);
		const trailingNewlines = this.countNewlines(trailingRemoved);

		return {
			text: trimmedText,
			startLine: span.startLine + leadingNewlines,
			endLine: span.endLine - trailingNewlines,
		};
	}

	/**
	 * 根据 rawText 的 trim 情况，计算真实的 startLine/endLine。
	 *
	 * baseStartLine 是 rawText 在原文中的起始行；通过统计 leading/trailing 的换行数来修正范围。
	 */
	private computeTrimmedRange(
		baseStartLine: number,
		rawText: string,
	): { startLine: number; endLine: number } {
		const trimStartText = rawText.trimStart();
		const leadingRemoved = rawText.slice(0, rawText.length - trimStartText.length);
		const leadingNewlines = this.countNewlines(leadingRemoved);

		const trimEndText = rawText.trimEnd();
		const trailingRemoved = rawText.slice(trimEndText.length);
		const trailingNewlines = this.countNewlines(trailingRemoved);

		const rawNewlines = this.countNewlines(rawText);
		return {
			startLine: baseStartLine + leadingNewlines,
			endLine: baseStartLine + rawNewlines - trailingNewlines,
		};
	}

	/**
	 * 对 rawText 做 trimStart，并把 trim 掉的换行数折算到 startLine 上。
	 * 这个辅助函数用于 splitOversizedSpan 中推进 remainingStartLine。
	 */
	private trimStartWithLineOffset(
		rawText: string,
		baseStartLine: number,
	): { text: string; startLine: number } {
		const trimmedText = rawText.trimStart();
		const removed = rawText.slice(0, rawText.length - trimmedText.length);
		return {
			text: trimmedText,
			startLine: baseStartLine + this.countNewlines(removed),
		};
	}
}

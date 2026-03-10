import type { ChunkMeta } from "../types";

type Section = {
	heading: string;
	text: string;
};

const MIN_CHUNK_LENGTH = 50;
const MAX_CHUNK_LENGTH = 1200;
const SOFT_SPLIT_FLOOR = Math.max(MIN_CHUNK_LENGTH, Math.floor(MAX_CHUNK_LENGTH * 0.6));
const SENTENCE_BOUNDARIES = ".!?;\u3002\uFF01\uFF1F\uFF1B";
const CLAUSE_BOUNDARIES = ",:\uFF0C\u3001\uFF1A";

export class Chunker {
	chunk(notePath: string, content: string): ChunkMeta[] {
		const normalizedContent = this.normalizeLineEndings(content);
		const body = this.stripFrontmatter(normalizedContent);
		if (!body.trim()) {
			return [];
		}

		const sections = this.splitByHeadings(body);
		const chunks: ChunkMeta[] = [];
		let order = 0;

		for (const section of sections) {
			const sectionChunks = this.buildSectionChunks(section);
			for (const text of sectionChunks) {
				const trimmedText = text.trim();
				if (!trimmedText) {
					continue;
				}

				chunks.push({
					chunkId: `${notePath}#${order}`,
					notePath,
					heading: section.heading,
					text: trimmedText,
					order,
				});
				order++;
			}
		}

		return chunks;
	}

	private normalizeLineEndings(content: string): string {
		return content.replace(/\r\n?/g, "\n");
	}

	private stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)\n*/, "");
	}

	private splitByHeadings(content: string): Section[] {
		const sections: Section[] = [];
		const lines = content.split("\n");
		const headingStack: string[] = [];
		let currentHeading = "";
		let currentLines: string[] = [];
		let activeFenceMarker: string | null = null;

		const flushSection = (): void => {
			const text = currentLines.join("\n").trim();
			if (!text) {
				currentLines = [];
				return;
			}

			sections.push({
				heading: currentHeading,
				text,
			});
			currentLines = [];
		};

		for (const line of lines) {
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

			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushSection();

		if (sections.length > 0) {
			return sections;
		}

		const fallbackText = content.trim();
		return fallbackText ? [{ heading: "", text: fallbackText }] : [];
	}

	private buildSectionChunks(section: Section): string[] {
		const blocks = this.splitIntoBlocks(section.text);
		if (blocks.length === 0) {
			return [];
		}

		const chunks: string[] = [];
		let current = "";

		const flushCurrent = (): void => {
			const trimmed = current.trim();
			if (trimmed) {
				chunks.push(trimmed);
			}
			current = "";
		};

		for (const block of blocks) {
			const fragments = this.splitOversizedText(block);
			for (const fragment of fragments) {
				if (!current) {
					current = fragment;
					continue;
				}

				const merged = `${current}\n\n${fragment}`;
				if (current.length < MIN_CHUNK_LENGTH || merged.length <= MAX_CHUNK_LENGTH) {
					current = merged;
					continue;
				}

				flushCurrent();
				current = fragment;
			}
		}

		if (current) {
			const trimmed = current.trim();
			const previous = chunks[chunks.length - 1];
			if (
				trimmed.length < MIN_CHUNK_LENGTH &&
				previous &&
				`${previous}\n\n${trimmed}`.length <= MAX_CHUNK_LENGTH
			) {
				chunks[chunks.length - 1] = `${previous}\n\n${trimmed}`;
			} else {
				flushCurrent();
			}
		}

		return chunks.filter((chunk) => chunk.trim().length > 0);
	}

	private splitIntoBlocks(text: string): string[] {
		const blocks: string[] = [];
		const lines = text.split("\n");
		let currentLines: string[] = [];
		let activeFenceMarker: string | null = null;

		const flushBlock = (): void => {
			const block = currentLines.join("\n").trim();
			if (block) {
				blocks.push(block);
			}
			currentLines = [];
		};

		for (const line of lines) {
			if (!activeFenceMarker && line.trim().length === 0) {
				flushBlock();
				continue;
			}

			currentLines.push(line);
			activeFenceMarker = this.updateFenceMarker(line, activeFenceMarker);
		}

		flushBlock();
		return blocks;
	}

	private splitOversizedText(text: string): string[] {
		const trimmed = text.trim();
		if (!trimmed) {
			return [];
		}
		if (trimmed.length <= MAX_CHUNK_LENGTH) {
			return [trimmed];
		}

		const fragments: string[] = [];
		let remaining = trimmed;

		while (remaining.length > MAX_CHUNK_LENGTH) {
			const splitPoint = this.findSplitPoint(remaining, MAX_CHUNK_LENGTH);
			const fragment = remaining.slice(0, splitPoint).trim();

			if (!fragment) {
				fragments.push(remaining.slice(0, MAX_CHUNK_LENGTH).trim());
				remaining = remaining.slice(MAX_CHUNK_LENGTH).trimStart();
				continue;
			}

			fragments.push(fragment);
			remaining = remaining.slice(splitPoint).trimStart();
		}

		if (remaining) {
			fragments.push(remaining);
		}

		return fragments.filter((fragment) => fragment.length > 0);
	}

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
}

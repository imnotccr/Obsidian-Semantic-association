/**
 * Chunker - 笔记内容切分器
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Indexing Layer（索引层）                    │
 * │  被谁调用：ReindexService.indexFile()                       │
 * │  参见：ARCHITECTURE.md「五、索引流程 → 5.1 全量索引」        │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 负责将一篇笔记的 Markdown 内容切分为多个语义块（chunks）。
 * 每个 chunk 会独立生成 embedding 向量，用于段落级的精确检索。
 *
 * ## 为什么需要 chunk 切分
 *
 * 如果只对整篇笔记生成一个向量（note-level），那搜索结果只能告诉用户
 * 「这篇笔记和你的查询相关」，但无法告诉用户「具体是哪一段最相关」。
 *
 * 切分为 chunks 后，可以做到：
 * 1. ConnectionsView 展示候选笔记中「最契合的一段文字」
 * 2. LookupView 的搜索结果精确到段落级别
 *
 * ## v1 切分规则
 *
 * 1. 按 Markdown 标题（# ~ ######）切分
 * 2. 标题之间的内容归入该标题块
 * 3. 没有标题的顶部内容作为第一个块（heading 为空）
 * 4. 过短的块（< 50 字符）合并到前一个块，避免碎片化
 * 5. 有标题的块即使很短也不合并，因为标题本身就是语义边界
 *
 * ## 切分示例
 *
 * 输入 Markdown：
 * ```
 * ---
 * tags: [python]
 * ---
 * 这是一段简介。
 *
 * ## 基础概念
 * Python 是一种编程语言...（200字）
 *
 * ## 类型系统
 * Python 采用动态类型...（300字）
 *
 * ## 小结
 * 短短一句话。
 * ```
 *
 * 输出 chunks：
 * | order | heading    | text                           |
 * |-------|------------|--------------------------------|
 * | 0     | ""         | "这是一段简介。"               |
 * | 1     | "基础概念" | "Python 是一种编程语言..."     |
 * | 2     | "类型系统" | "Python 采用动态类型..."       |
 * | 3     | "小结"     | "短短一句话。"                 |
 *
 * 注意：chunk 0 没有标题（文件开头的内容）。
 * 注意：chunk 3 虽然很短但有标题，不会被合并。
 *
 * ## 数据流
 *
 * ReindexService.indexFile()
 *   → Chunker.chunk(notePath, content)
 *     → removeFrontmatter()     去掉 YAML 头
 *     → splitByHeadings()       按标题行切分
 *     → mergeShortSections()    合并碎片
 *     → 返回 ChunkMeta[]（不含 vector）
 *       → EmbeddingService.embedBatch()  为每个 chunk 生成向量
 */

import type { ChunkMeta } from "../types";

/**
 * 最小块长度（字符数）
 *
 * 低于此长度的无标题块会被合并到前一个块。
 * 50 字符大约是一句话的长度。太短的块信息量太低，
 * 生成的 embedding 向量区分度差，不利于精确检索。
 */
const MIN_CHUNK_LENGTH = 50;

export class Chunker {
	/**
	 * 将笔记内容切分为 chunks
	 *
	 * 这是 Chunker 的唯一公共方法。整个切分过程分三步：
	 * 1. removeFrontmatter：去掉 YAML 头部
	 * 2. splitByHeadings：按标题行切分为原始段落
	 * 3. mergeShortSections：合并过短的碎片段落
	 *
	 * @param notePath - 笔记路径，用于构造 chunkId（格式：path#order）
	 * @param content  - 笔记原始 Markdown 内容
	 * @returns ChunkMeta 数组。注意 vector 字段为空，
	 *          由 ReindexService 在 embedding 阶段填充。
	 */
	chunk(notePath: string, content: string): ChunkMeta[] {
		// 第一步：去掉 frontmatter（YAML 元数据不应参与语义索引）
		const body = this.removeFrontmatter(content);
		if (!body.trim()) return [];

		// 第二步：按标题切分为原始段落
		const rawSections = this.splitByHeadings(body);

		// 第三步：合并过短的段落，减少碎片化
		const mergedSections = this.mergeShortSections(rawSections);

		// 转换为 ChunkMeta 结构
		// chunkId 格式：${notePath}#${index}
		// 这个格式让 VectorStore 可以通过 # 区分 note 向量和 chunk 向量
		return mergedSections.map((section, index) => ({
			chunkId: `${notePath}#${index}`,
			notePath,
			heading: section.heading,
			text: section.text.trim(),
			order: index,
		}));
	}

	/**
	 * 去除 frontmatter（YAML 头部）
	 *
	 * Frontmatter 格式：以 --- 开头和结尾的 YAML 块
	 * ```
	 * ---
	 * title: Hello
	 * tags: [a, b]
	 * ---
	 * 正文开始...
	 * ```
	 *
	 * 使用非贪婪匹配 [\s\S]*? 确保只匹配第一个 --- 对。
	 * ^--- 确保只匹配文件开头的 frontmatter（正文中的 --- 不受影响）。
	 */
	private removeFrontmatter(content: string): string {
		return content.replace(/^---[\s\S]*?---\n*/, "");
	}

	/**
	 * 按标题行切分内容
	 *
	 * 遍历每一行，遇到标题行时「提交当前段落，开始新段落」。
	 *
	 * 识别规则：匹配 # ~ ###### 开头的行（标准 Markdown 标题语法）。
	 * 注意：不匹配 `#tag` 或 `#没有空格的标题`，
	 * 因为 Markdown 规范要求 # 后面有空格。
	 *
	 * 特殊情况：
	 * - 文件开头没有标题：这些内容归入第一个段落（heading 为空字符串）
	 * - 连续两个标题之间没有内容：产生一个空文本的段落
	 *
	 * @returns Section[] — 原始段落列表（未经合并处理）
	 */
	private splitByHeadings(body: string): Section[] {
		const lines = body.split("\n");
		const sections: Section[] = [];
		// 当前正在收集的段落的标题（空字符串表示无标题的开头部分）
		let currentHeading = "";
		// 当前段落中收集的所有行
		let currentLines: string[] = [];

		// 正则：匹配 "# 标题" 到 "###### 标题"
		// 第一个捕获组：# 的数量（标题级别）
		// 第二个捕获组：标题文本
		const headingRegex = /^(#{1,6})\s+(.+)$/;

		for (const line of lines) {
			const match = line.match(headingRegex);

			if (match) {
				// 遇到新标题 → 保存当前段落并开始新段落
				if (currentLines.length > 0 || currentHeading) {
					sections.push({
						heading: currentHeading,
						text: currentLines.join("\n"),
					});
				}
				// 开始新段落：记录新标题，清空行缓冲
				currentHeading = match[2].trim();
				currentLines = [];
			} else {
				// 非标题行 → 加入当前段落的行缓冲
				currentLines.push(line);
			}
		}

		// 别忘了保存最后一个段落
		if (currentLines.length > 0 || currentHeading) {
			sections.push({
				heading: currentHeading,
				text: currentLines.join("\n"),
			});
		}

		return sections;
	}

	/**
	 * 合并过短的段落到前一个段落
	 *
	 * 为什么要合并？
	 * - 太短的 chunk（如只有一个空行或几个字）信息量极低
	 * - 为其生成的 embedding 向量几乎没有语义区分度
	 * - 合并后可以减少 chunk 数量，降低 embedding 调用次数和存储开销
	 *
	 * 合并规则：
	 * - 只合并无标题的短段落（有标题的段落是明确的语义边界，不合并）
	 * - 合并到前一个段落（而非后一个），因为语义上通常与前文更相关
	 * - 如果第一个段落就很短且无标题，它不会被合并（没有前一个段落可合并到）
	 */
	private mergeShortSections(sections: Section[]): Section[] {
		if (sections.length <= 1) return sections;

		const merged: Section[] = [];

		for (const section of sections) {
			const textLength = section.text.trim().length;

			if (
				merged.length > 0 &&                // 有前一个段落可合并到
				textLength < MIN_CHUNK_LENGTH &&     // 文本太短
				!section.heading                     // 没有标题（有标题则保留）
			) {
				// 合并到前一个段落：将文本追加到前一个段落的末尾
				const prev = merged[merged.length - 1];
				prev.text += "\n" + section.text;
			} else {
				// 不合并：作为独立段落保留
				merged.push({ ...section });
			}
		}

		return merged;
	}
}

/**
 * 内部数据结构：切分后的原始段落
 *
 * 这是 Chunker 内部使用的中间结构，不对外暴露。
 * 最终输出时会转换为 ChunkMeta（加上 chunkId、notePath、order）。
 */
interface Section {
	/** 段落标题。空字符串表示文件开头的无标题内容 */
	heading: string;
	/** 段落正文内容（不含标题行本身） */
	text: string;
}

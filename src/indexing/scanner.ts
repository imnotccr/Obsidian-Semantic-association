/**
 * Scanner - Vault 文件扫描器
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │  在架构中的位置：Indexing Layer（索引层）                    │
 * │  被谁调用：ReindexService                                   │
 * │  参见：ARCHITECTURE.md「五、索引流程」                       │
 * └─────────────────────────────────────────────────────────────┘
 *
 * 负责「发现文件」和「读取内容」，是索引流程的第一步。
 * 不负责切分、embedding、存储等后续步骤。
 *
 * ## 职责边界
 *
 * Scanner 只做两件事：
 * 1. 告诉 ReindexService「vault 中有哪些文件需要索引」
 * 2. 告诉 ReindexService「这个文件的内容和元数据是什么」
 *
 * 它不知道 chunk、embedding、vector 的存在。
 * 这样当索引策略变化时（如新增文件类型支持），只需修改 Scanner。
 *
 * ## 与 Obsidian API 的交互
 *
 * - vault.getMarkdownFiles()：获取所有 .md 文件列表
 * - vault.cachedRead(file)：读取文件内容（优先使用缓存，比 read() 更快）
 * - metadataCache.getFileCache(file)：获取 Obsidian 解析的结构化缓存
 *   包括 frontmatter、headings、tags、links 等，省去自己解析 Markdown
 *
 * ## 数据流
 *
 * Scanner.getMarkdownFiles()
 *   → ReindexService 拿到文件列表
 *     → 对每个文件调用 Scanner.readContent() + Scanner.buildNoteMeta()
 *       → 得到内容和 NoteMeta
 *         → 传给 Chunker.chunk() 做切分
 */

import { TFile, Vault, MetadataCache, CachedMetadata } from "obsidian";
import type { NoteMeta } from "../types";
import { hashContent } from "../utils/hash";

export class Scanner {
	/**
	 * @param vault          - Obsidian Vault API，用于文件操作
	 * @param metadataCache  - Obsidian 元数据缓存，用于提取结构化信息
	 */
	constructor(
		private vault: Vault,
		private metadataCache: MetadataCache,
	) {}

	/**
	 * 扫描 vault 中所有符合条件的 Markdown 文件
	 *
	 * 过滤逻辑：排除用户在设置中指定的文件夹（如 templates、archive）。
	 * 排除判断使用路径前缀匹配，例如排除 "templates" 会过滤掉
	 * "templates/daily.md" 和 "templates/weekly/todo.md"。
	 *
	 * @param excludedFolders - 排除的文件夹路径列表
	 * @returns 需要索引的 TFile 列表
	 */
	getMarkdownFiles(excludedFolders: string[]): TFile[] {
		return this.vault.getMarkdownFiles().filter((file) => {
			return !excludedFolders.some((folder) =>
				// 匹配两种情况：
				// 1. file.path 以 "folder/" 开头（文件在该文件夹内）
				// 2. file.path === folder（路径完全匹配，边界情况）
				file.path.startsWith(folder + "/") || file.path === folder
			);
		});
	}

	/**
	 * 读取单个文件的文本内容
	 *
	 * 使用 cachedRead 而非 read 的原因：
	 * cachedRead 优先返回 Obsidian 内存中的缓存内容，
	 * 避免每次都走磁盘 IO。在批量索引 1000+ 文件时，
	 * 这个差异很明显。
	 */
	async readContent(file: TFile): Promise<string> {
		return this.vault.cachedRead(file);
	}

	/**
	 * 为单个文件构建 NoteMeta 元数据
	 *
	 * 从文件内容和 Obsidian MetadataCache 中提取所需信息。
	 * MetadataCache 是 Obsidian 自动维护的结构化缓存，
	 * 包含已解析的 frontmatter、headings、tags、links 等，
	 * 比自己解析 Markdown 更可靠。
	 *
	 * @param file    - 目标文件（提供 path、basename、stat 等信息）
	 * @param content - 已读取的文件内容（用于生成 hash 和 summary）
	 * @returns NoteMeta（不含 vector，vector 在 embedding 阶段填充）
	 */
	buildNoteMeta(file: TFile, content: string): NoteMeta {
		const cache = this.metadataCache.getFileCache(file);

		return {
			path: file.path,
			title: this.extractTitle(file, cache),
			mtime: file.stat.mtime,
			// hash 用于增量索引：如果 hash 没变，说明内容没改，可以跳过重新索引
			hash: hashContent(content),
			tags: this.extractTags(cache),
			outgoingLinks: this.extractLinks(cache),
			// summaryText 用于生成 note-level embedding
			// 取前 500 字而非全文，因为：
			// 1. embedding 模型有 token 限制
			// 2. 笔记开头通常是最能概括全文的部分
			summaryText: this.extractSummary(content),
		};
	}

	/**
	 * 提取笔记标题
	 *
	 * 按优先级尝试三个来源：
	 * 1. frontmatter 的 title 字段 — 用户明确指定的标题
	 * 2. 正文中的首个 h1 标题 — 常见的笔记标题写法
	 * 3. 文件名（去掉 .md 扩展名）— 兜底方案
	 *
	 * 这个优先级与 Obsidian 自身的标题显示逻辑一致。
	 */
	private extractTitle(file: TFile, cache: CachedMetadata | null): string {
		if (cache?.frontmatter?.title) {
			return cache.frontmatter.title;
		}

		if (cache?.headings) {
			const h1 = cache.headings.find((h) => h.level === 1);
			if (h1) return h1.heading;
		}

		// basename 是 Obsidian 提供的属性，已去掉扩展名
		return file.basename;
	}

	/**
	 * 从缓存中提取所有标签
	 *
	 * Obsidian 中的标签有两种来源：
	 * 1. frontmatter 中的 tags 字段（可以是数组或单个字符串）
	 * 2. 正文中的内联 #tag
	 *
	 * 使用 Set 去重，因为同一个 tag 可能同时出现在两处。
	 * 正文 tag 去掉前导 # 以统一格式（frontmatter 中的 tag 没有 #）。
	 */
	private extractTags(cache: CachedMetadata | null): string[] {
		const tags = new Set<string>();

		// 来源 1：frontmatter tags
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			// frontmatter 的 tags 可以是数组 ["a", "b"] 或单个字符串 "a"
			if (Array.isArray(fmTags)) {
				fmTags.forEach((t: string) => tags.add(t));
			} else if (typeof fmTags === "string") {
				tags.add(fmTags);
			}
		}

		// 来源 2：正文中的 #tag（Obsidian 缓存中自带 # 前缀）
		if (cache?.tags) {
			cache.tags.forEach((t) => tags.add(t.tag.replace(/^#/, "")));
		}

		return Array.from(tags);
	}

	/**
	 * 从缓存中提取出链（outgoing links）
	 *
	 * 包含两种链接格式：
	 * - [[wikilinks]]
	 * - [markdown](links)
	 *
	 * 出链信息当前用于 NoteMeta 存储，v1 未用于搜索排序，
	 * 后续可用于图结构辅助排序（与当前笔记有链接关系的笔记加分）。
	 */
	private extractLinks(cache: CachedMetadata | null): string[] {
		const links: string[] = [];

		if (cache?.links) {
			cache.links.forEach((link) => {
				if (link.link) links.push(link.link);
			});
		}

		return links;
	}

	/**
	 * 提取摘要文本（用于生成 note-level embedding）
	 *
	 * 策略：取正文前 500 字符（跳过 frontmatter）。
	 *
	 * 为什么是 500 字符？
	 * - 太短（如 100 字）：信息不足，note-level 向量质量差
	 * - 太长（如全文）：embedding 模型有 token 限制（通常 8192），
	 *   且长文本的 embedding 质量反而不如精简摘要
	 * - 500 字符是一个平衡点，通常能覆盖笔记的核心主题
	 *
	 * 为什么跳过 frontmatter？
	 * - frontmatter 是 YAML 格式的元数据（如 tags、date），
	 *   不是自然语言文本，会干扰 embedding 的语义理解
	 */
	private extractSummary(content: string): string {
		const withoutFm = content.replace(/^---[\s\S]*?---\n*/, "");
		return withoutFm.slice(0, 500).trim();
	}
}

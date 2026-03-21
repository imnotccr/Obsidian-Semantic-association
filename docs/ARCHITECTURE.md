# 语义关联（Semantic Connections）架构说明

## 概览

本插件当前只支持一个 embedding provider：`remote`，并向 **OpenAI 兼容**的 `/v1/embeddings` 接口发送请求生成向量。

- 默认远程模型：`BAAI/bge-m3`
- 插件内部只处理 **单一 dense 向量**：`number[]`（每段文本对应一个向量）

## 分层（Layers）

### UI（视图 / 命令 / 设置）

- `src/views/connections-view.ts`
- `src/views/lookup-view.ts`（语义搜索待办界面，当前不作为正式支持范围）
- `src/settings.ts`

该层负责渲染视图、注册命令与设置项，本身不实现索引或检索算法。

### Indexing（扫描 / 切分 / 索引）

- `src/indexing/scanner.ts`
- `src/indexing/chunker.ts`
- `src/indexing/reindex-service.ts`
- `src/indexing/reindex-queue.ts`

该层负责扫描 Markdown、切分 chunk、执行全量重建，以及在需要时处理 delete/rename 等任务；同时提供“同步变动笔记/重试失败项”等手动入口，以避免后台自动消耗远程 Embeddings API。

### Embeddings（向量生成）

- `src/embeddings/provider.ts`
- `src/embeddings/remote-provider.ts`
- `src/embeddings/embedding-service.ts`

`EmbeddingService` 是索引与搜索共用的唯一入口，主要操作：

- `embed(text)`
- `embedBatch(texts)`

### Storage（本地存储）

- `src/storage/note-store.ts`
- `src/storage/chunk-store.ts`
- `src/storage/vector-store.ts`

磁盘索引快照由两部分组成：

- `index-store.json`（结构化元数据快照）
- `index-vectors.bin`（向量快照，Float32 二进制）

### Search（检索）

- `src/search/connections-service.ts`
- `src/search/lookup-service.ts`（语义搜索待办链路）
- `src/search/passage-selector.ts`

说明：当前正式维护和对外文档承诺的检索能力以“关联视图”为主。`lookup-view.ts` / `lookup-service.ts` 相关的自然语言查询能力暂列待办，不纳入当前阶段的稳定交付范围。

## Chunk 切分策略（Chunking Strategy）

当前切分策略：`paragraph-first-v3-overlap20`。

主要行为：

1. 按标题（heading）把 markdown 拆成段落语境。
2. 切分前移除 YAML frontmatter。
3. 标题保存在元数据里，不直接插入 chunk 的正文文本。
4. 构建 chunk 时优先使用段落边界。
5. 尽可能合并非常短的相邻段落。
6. 对过长段落再按句子/分句/空白边界进一步拆分。
7. 相邻 chunk 采用滑动窗口重叠（overlap），默认是 `maxChunkLength` 的 20%。

当前限制（chunker 输出，按字符数计算）：

- `minChunkLength = 300`
- `maxChunkLength = 800`
- `overlap = 20%`（`maxChunkLength = 800` 时约 160 字符，stride 约 640）

这些限制是本地切分的字符数护栏，不等同于远程模型的 token 限制。

注意：`ReindexService` 会对最终 embedding payload 再做一次长度校验，限制为 `1200` 字符（payload 形如 `{heading}\n\n{text}`）。当标题存在时，正文 `text` 的可用长度会被压缩，索引阶段可能再次拆分。

## 标题上下文（Heading Context）

Chunk 元数据仍然保留：

- `heading`
- `text`
- `order`

构建 embedding payload 时，`ReindexService` 发送：

```text
{heading}

{text}
```

若 chunk 没有标题，则只发送正文文本。

这样做可以让 UI 渲染的片段保持“干净”，同时 embedding 仍能利用标题上下文。

为避免超长标题主导 embedding，标题上下文会在拼接前截断到 200 字符（并追加省略号）。

## 远程 Provider（remote）

### 请求格式（Request Format）

插件发送的请求形如：

```http
POST {baseUrl}/v1/embeddings
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "model": "BAAI/bge-m3",
  "input": ["text 1", "text 2"]
}
```

### 响应结构（Response Shape）

插件期望响应形如：

```json
{
  "data": [
    { "embedding": [0.1, 0.2] },
    { "embedding": [0.3, 0.4] }
  ]
}
```

### 输入安全（Input Safety）

发起远程请求前，插件会：

- 去除 frontmatter
- 跳过空 chunk
- 本地拆分过长 chunk
- 重新校验最终 `heading + text` payload 长度
- 避免调用 `embedBatch([])`

## 索引流程（Indexing Flow）

### 启动（Startup）

`src/main.ts` 的启动顺序：

1. `loadSettings()`
2. `createServices()`
3. 注册 views / commands / settings
4. `onLayoutReady()`

### 布局就绪（Layout Ready）

`onLayoutReady()` 的关键步骤：

1. 加载运行日志与错误日志
2. 尝试恢复磁盘索引快照（`index-store.json` + `index-vectors.bin`）
3. 注册文件事件（仅在开启 `autoIndex` 时生效：用于标记 dirty/outdated、处理 delete/rename 等）
4. 按配置自动打开右侧关联视图
5. 必要时提醒用户手动重建索引（默认不会自动全量重建，以避免意外远程 API 消耗）

插件会记录 `lastFullRebuildAt`，当距离上次全量重建 ≥ 7 天时，在启动时弹出提醒（仍需用户手动触发“重建索引”）。

### 全量重建（Full Rebuild）

`rebuildIndex()` 的高层流程：

1. 清理旧的错误日志
2. 清空内存索引状态（NoteStore/ChunkStore/VectorStore）
3. 执行 `ReindexService.indexAll(...)`
4. 保存索引快照
5. 更新 UI 进度与运行日志

### 同步变动笔记（手动）

插件不会在后台自动为每次编辑调用 embedding。要让索引“变得更准”，需要你手动触发同步：

- 命令 `Sync Changed Notes（同步变动笔记）` 会扫描 Vault，找出新增/修改/标记为 dirty 的笔记，确认后逐篇生成 embedding 并更新索引。
- 若索引过程中出现网络中断/429 等可重试错误，会记录到 `failed-tasks.json`，之后可通过“重试失败项”再次处理。

## 关联视图排序（Connections Ranking）

`ConnectionsService` 通过 **直接检索 chunk 向量** 并回聚到笔记，避免“大笔记 note-level 均值向量语义稀释”导致的召回问题。

高层流程：

1. 为当前笔记选择查询向量：优先使用已持久化的 note-level 向量；缺失时用当前笔记 chunk 向量的均值兜底。
2. 在全量 chunk 向量中检索（`id` 包含 `#`），得到 topK chunk 命中。
3. 按 `notePath`（由 `chunkId` 解析得到）把命中聚合成候选笔记。
4. 对每篇候选笔记：
   - 使用 `PassageSelector` 对候选笔记 chunks 重新打分（候选 chunk 与当前笔记所有 chunk 的最大相似度）
   - 按相似度排序，并按 `maxPassagesPerNote` 截断
   - 计算 `passageScore`（log-sum-exp 聚合）用于透明化展示
   - 排序主分数使用 `finalScore = bestPassage.score`（让 UI 展示的“最强片段”与排序口径一致）
   - 将 `minSimilarityScore` 作为软阈值：仍会保留少量 top-N 兜底结果，避免 UI 为空

`ConnectionResult` 会保留：

- `score`（finalScore，等于 `bestPassage.score`）
- `noteScore`（与 `bestPassage.score` 等价，兼容字段）
- `passageScore`（聚合分数）
- `bestPassage`（最高分 chunk，用于片段预览）
- `passages`（截断后的候选片段集合）

## 快照兼容性（Snapshot Compatibility）

当前快照版本为 `3`。

快照兼容性校验字段包括：

- `embeddingProvider`
- `remoteBaseUrl`
- `remoteModel`
- `embeddingDimension`
- `chunkingStrategy`
- `noteVectorStrategy`

其中任一变化都会导致跳过加载快照，并提示用户手动重建索引。

## 本地文件（Local Files）

本地测试配置保存在 `data.json`。该文件以及 `debug-artifacts/` 已在 `.gitignore` 中忽略，不应提交到仓库。

## 构建（Build）

```bash
npm run build
```

构建产物：

- `main.js`
- `dist/main.js`（生产构建会清理 `dist/` 后再复制）
- `dist/manifest.json`
- `dist/styles.css`

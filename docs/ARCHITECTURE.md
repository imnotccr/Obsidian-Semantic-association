# Semantic Connections 架构说明

## 概览

当前插件只保留两种 embedding provider：

- `remote`：通过 OpenAI 兼容的 `/v1/embeddings` 接口请求远程向量
- `mock`：用于本地开发和调试的假向量 provider

默认远程模型是 `BAAI/bge-m3`。插件内部统一处理单个 dense vector，即 `number[]`，不支持 sparse embedding、ColBERT 或 multi-vector。

## 分层

### UI

- `src/views/connections-view.ts`
- `src/views/lookup-view.ts`
- `src/settings.ts`

负责视图展示、命令入口和配置编辑，不直接承担索引或检索的核心逻辑。

### Indexing

- `src/indexing/scanner.ts`
- `src/indexing/chunker.ts`
- `src/indexing/reindex-service.ts`
- `src/indexing/reindex-queue.ts`

负责扫描 Markdown、切分 chunk、全量重建索引和增量更新。

### Embeddings

- `src/embeddings/provider.ts`
- `src/embeddings/mock-provider.ts`
- `src/embeddings/remote-provider.ts`
- `src/embeddings/embedding-service.ts`

`EmbeddingService` 是唯一入口。索引和检索主流程只依赖：

- `embed(text)`
- `embedBatch(texts)`

### Storage

- `src/storage/note-store.ts`
- `src/storage/chunk-store.ts`
- `src/storage/vector-store.ts`

索引落盘由两部分组成：

- `index-store.json`
- `index-vectors.bin`

### Search

- `src/search/connections-service.ts`
- `src/search/lookup-service.ts`
- `src/search/passage-selector.ts`

## Chunking 策略

### paragraph-first 切块

`src/indexing/chunker.ts` 当前使用 `paragraph-first-v2` 策略：

1. 先按 Markdown 标题切成 section
2. 在切块前先剥离顶层 YAML frontmatter，避免笔记元数据污染段落语义
3. 标题本身不进入 chunk 正文，而是作为 `heading` 元数据保留
4. 每个 section 内再按空行优先拆成段落块
5. 短段落会尽量和相邻段落合并，避免过碎
6. 超长段落会继续二次分片，优先找换行、句号、逗号、空格等边界

当前实现里的目标长度：

- `minChunkLength = 50`
- `maxChunkLength = 1200`

这两个值是插件侧的保守保护值，用来降低远程服务因为空输入、过短碎片或超长输入而返回 `400 invalid parameter` 的概率，不是远程模型官方 token 上限。

### heading 作为上下文，而不是正文污染

Chunk 存储结构仍然保留：

- `heading`
- `text`
- `order`

但 embedding 时不再只传 `chunk.text`。`ReindexService` 会构造：

```text
{heading}

{text}
```

如果当前 chunk 没有标题，则只传正文。这样做的目的有两个：

- 展示时仍然保留原始段落文本，避免标题重复出现在 passage 正文里
- 向量计算时能拿到标题上下文，提高段落语义对齐能力

`ReindexService` 在真正发送远程请求前，还会基于这个最终字符串再做一次长度保护：

- 先按实际参与 embedding 的 `heading + text` 计算可用正文长度
- 如果加上标题上下文后仍可能超限，会把该 chunk 继续拆成更小的 chunk
- 标题上下文本身也会做裁剪，避免超长标题把正文可用空间全部吃掉

## Remote Provider

### 请求格式

插件按 OpenAI 兼容 embeddings API 请求远程服务：

```http
POST {baseUrl}/v1/embeddings
Authorization: Bearer {apiKey}
Content-Type: application/json
```

```json
{
  "model": "BAAI/bge-m3",
  "input": ["文本1", "文本2"]
}
```

### 响应要求

插件期望响应结构如下：

```json
{
  "data": [
    { "embedding": [0.1, 0.2] },
    { "embedding": [0.3, 0.4] }
  ]
}
```

### 输入保护

进入远程 API 之前，插件会做这些保护：

- chunker 会先剥离 frontmatter，不把 YAML 元数据送进段落向量
- 空 chunk 会被过滤，不会发送空字符串
- 超长段落会在本地继续拆分
- 即使 `chunk.text` 本身未超限，最终的 `heading + text` payload 也会再做一次长度校验和二次拆分
- 空批次不会触发 `embedBatch([])` 的远程请求

### 端到端链路

一次完整的远程 embeddings 索引链路如下：

1. `Scanner` 读取 Markdown，提取 `summaryText`、标题、tags、frontmatter 等元数据
2. `Chunker` 先去掉顶层 frontmatter，再按标题切 section，按段落优先切 chunk
3. `ReindexService` 为每个 chunk 构造最终 embedding 文本，也就是 `heading + text`
4. 如果最终 payload 为空、超长，或需要继续拆分，会先在本地处理；本地无法修复时直接抛出索引层错误码
5. `EmbeddingService` 把请求转给 `RemoteProvider`
6. `RemoteProvider` 把 `input[]` 发到 `{baseUrl}/v1/embeddings`
7. 收到响应后，先校验 HTTP 状态、JSON 结构、`data[]` 数量、向量维度
8. `ReindexService` 再校验“返回向量数”是否和“发送的 chunk 数”一致，最后才写入 note/chunk store

这也解释了一个常见现象：目录扫描和切块都完成后，错误才出现。因为真正的远程调用发生在扫描之后，问题往往出在“最终 payload 校验”或“远程 embeddings 请求/响应”阶段，而不是目录遍历阶段。

### 错误诊断

远程 API 或索引流程失败时，错误日志会尽量保留这些字段：

- `errorCode`
- `stage`
- `details`

`details` 中常见附加信息包括：

- `status=400`
- `input_count=16`
- `index_mode=full`
- `index_mode=incremental`
- `task_type=modify`
- `old_path=...`

这样可以直接区分是 provider 配置问题、请求发送问题、响应结构问题，还是某次全量/增量索引触发的输入异常。

与 paragraph-first / 最终 payload 保护相关的本地错误码包括：

- `ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID`
  含义：根据 `heading + text` 计算出的正文可用长度不合法
- `ERR_INDEX_CHUNK_SPLIT_STALLED`
  含义：二次拆分时未能继续推进，通常表示拆分逻辑进入异常状态
- `ERR_INDEX_CHUNK_SPLIT_EMPTY`
  含义：非空 chunk 在二次拆分后没有产出有效分片
- `ERR_INDEX_CHUNK_PAYLOAD_EMPTY`
  含义：最终参与 embedding 的 payload 为空
- `ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG`
  含义：最终的 `heading + text` 仍然超过本地长度保护上限
- `ERR_INDEX_CHUNK_EMBED_REQUEST`
  含义：chunk embedding 请求失败，但底层 provider 没有给出更具体的错误码
- `ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH`
  含义：provider 返回的向量数量和 chunk 输入数量不一致
- `ERR_INDEX_NOTE_EMBED_REQUEST`
  含义：note summary embedding 请求失败，但底层 provider 没有给出更具体的错误码

排查时建议先看 `stage`，因为它比 message 更稳定：

- `provider-config`
  说明：Base URL、API Key、Model、Timeout、Batch Size 这类配置本身就无效
- `request-send` / `request-timeout`
  说明：请求未成功发出，通常是网络、超时或运行环境问题
- `response-status`
  说明：服务端已经响应，但返回了 4xx / 5xx
- `response-json` / `response-data` / `response-embedding` / `response-dimension`
  说明：服务端响应结构和插件预期不兼容
- `chunk-embedding-limit` / `chunk-embedding-split` / `chunk-embedding-validate`
  说明：问题出在本地切块、最终 payload 长度保护或二次拆分
- `chunk-embedding-request` / `chunk-embedding-response`
  说明：chunk 批量请求阶段失败，或返回数量和输入数量不一致
- `note-embedding-request`
  说明：note summary 的单条 embedding 请求失败

## 索引流程

### 启动阶段

`src/main.ts` 的启动顺序：

1. `loadSettings()`
2. `createServices()`
3. 注册 views / commands / setting tab
4. `onLayoutReady()`

### layout-ready

`onLayoutReady()` 负责：

1. 加载运行日志和错误日志
2. 尝试恢复索引快照
3. 注册文件事件
4. 自动打开 Connections View
5. 在索引为空且配置完整时触发全量重建

### 全量重建

`rebuildIndex()` 负责：

1. 清空旧错误日志
2. 清空内存索引
3. 调用 `ReindexService.indexAll(...)`
4. 保存索引快照
5. 更新 UI 进度和运行日志

## Connections 检索流程

`ConnectionsService` 当前使用“两阶段 + 混合分”流程：

1. 先用 note-level vector 做粗召回
2. 候选数按 `maxConnections * 4` 放大，给 rerank 留空间
3. `PassageSelector` 在候选笔记里找最相关的段落
4. 最终分数使用 note-level 和 passage-level 混合：

```text
finalScore = noteScore * 0.7 + passageScore * 0.3
```

`ConnectionResult` 里会同时保留：

- `score`：最终混合分
- `noteScore`：整篇笔记相似度
- `passageScore`：最佳段落相似度

Connections View 仍显示 `score`，但 hover 会显示三个分数，便于排查排序结果。

## 索引快照兼容

当前索引快照版本为 `3`，除了 embedding 配置外，还会记录：

- `chunkingStrategy = "paragraph-first-v2"`

加载快照时，如果发现以下任一项不兼容，会跳过加载并要求用户重建索引：

- `embeddingProvider`
- `remoteBaseUrl`
- `remoteModel`
- `embeddingDimension`
- `chunkingStrategy`

这意味着旧的标题优先切块快照不会继续被复用，避免“切块逻辑已经升级，但磁盘还是旧 chunk”这种错配。

## 本地配置与入库约束

用于本地测试的远程配置保存在 `data.json`。该文件以及 `debug-artifacts/` 都已经被 `.gitignore` 忽略，不应提交到仓库。

## 构建

```bash
npm run build
```

构建产物：

- `main.js`
- `dist/main.js`
- `dist/manifest.json`
- `dist/styles.css`

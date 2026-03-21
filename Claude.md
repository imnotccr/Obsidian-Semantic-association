# CLAUDE.md

## 项目定位

这是一个 Obsidian 语义索引插件。当前阶段优先维护关联视图、索引管理与变更同步；语义搜索相关链路暂列待办。

历史上 embedding 方案有两种（remote/local），当前仅支持：

- `remote`: OpenAI 兼容 `/v1/embeddings` 接口

本地模型相关实现已经移除。

## 当前约束

1. 插件内部只处理单一 dense 向量 `number[]`
2. 默认远程模型是 `BAAI/bge-m3`
3. 不支持 sparse embedding
4. 不支持 ColBERT / multi-vector
5. 不要重新引入 Transformers.js、本地 worker、模型缓存，除非用户明确要求

## 运行时会产生什么文件（Obsidian 内）

所有运行时产物都写在插件数据目录（由 Obsidian 管理）：

- `{vault}/{configDir}/plugins/semantic-connections/`
  - `data.json`：插件设置（包含远程 URL / API Key / 阈值等）
  - `index-store.json`：索引快照（JSON）
  - `index-vectors.bin`：向量快照（Float32 二进制）
  - `error-log.json`：错误日志（索引与运行时异常）
  - `runtime-log.json`：运行日志（事件记录）
  - `failed-tasks.json`：可重试的索引失败任务（网络/429 等）
  - `*.tmp`：保存索引快照时的临时文件（写入后会 rename；异常退出时可能残留）

注意：插件不会改写你的 `.md` 笔记，只会读取并在上述目录持久化索引/日志。

## 运行时产物流程图

```mermaid
flowchart TB
  A[Obsidian 加载插件 main.js] --> B[loadSettings() 读取 data.json]
  B --> C[createServices() 绑定数据文件路径]
  C --> D[loadIndexSnapshot() 读取 index-store.json + index-vectors.bin]
  D -->|快照可用| E[内存索引就绪\nNoteStore/ChunkStore/VectorStore]
  D -->|快照缺失/不兼容| F[重建索引 ReindexService]

  F --> G[Scanner 扫描笔记\n读取 vault/*.md]
  G --> H[Chunker 分块\n300–800 字符 + 20% overlap]
  H --> I[EmbeddingService(remote)\n请求 /v1/embeddings]
  I -->|成功| J[更新内存索引]
  I -->|失败可重试| K[写入 failed-tasks.json]
  J --> L[scheduleIndexSave()]
  L --> M[saveIndexSnapshot()\n写 *.tmp -> rename]
  M --> N[落盘 index-store.json + index-vectors.bin]

  C --> O[ErrorLogger/RuntimeLogger 初始化]
  O --> P[运行/索引异常]
  P --> Q[写入 error-log.json / runtime-log.json]

  E --> R[Connections 查询（当前）\nLookup / 语义搜索（待办）]
  R --> S[ConnectionsService + PassageSelector\n选择最强关联片段]
```

## 关键文件

- `src/main.ts`
  - 插件入口
  - 设置加载
  - 索引快照加载/保存
  - 命令注册
  - 重建索引

- `src/views/connections-view.ts`
  - 右侧「语义关联」视图渲染
  - UI 评分展示规则：
    - 统一术语：`相关度`
    - 主界面百分比 = `原始分值 × 100`（线性；无非线性映射）
    - Tooltip 显示 `原始分值: 0.xxx`（透明化底层数据）
  - 卡片正文展示「最强关联片段」预览，并在底部展示完整路径

- `src/settings.ts`
  - 设置页
  - 远程 API 配置
  - 关联视图配置（相关度阈值 `minSimilarityScore`、每篇最多展示段落数）
  - 测试连接

- `src/embeddings/remote-provider.ts`
  - OpenAI 兼容 embeddings 请求
  - 超时、HTTP、JSON、缺字段、维度不一致等错误处理

- `src/embeddings/embedding-service.ts`
  - provider 创建与切换

- `src/indexing/`
  - 扫描、切块、重建索引、增量索引

- `src/indexing/chunker.ts`
  - 分块策略（面向 BGE-M3 局部语义）：
    - 默认 chunk 文本长度约 `300–800` 字符
    - 相邻 chunk 追加 `20%` 重叠（`maxChunkLength=800` 时约 160 字符，stride 约 640）
  - 任何分块策略变更都需要「重建索引」才会体现在召回与片段展示上

- `src/storage/`
  - note/chunk/vector store

- `src/search/`
  - 当前重点是关联推荐；语义搜索暂列待办
  - `ConnectionsService`：
    - 先做 chunk-level 召回得到候选笔记
    - 再用 `PassageSelector` 在候选笔记内找出「最强关联片段」（用于 UI 与排序）
    - 仍保留 `passageScore`（log-sum-exp 聚合）用于透明化解释
  - `LookupService`：
    - 相关代码路径仍保留，作为后续语义搜索待办
    - 若后续恢复推进，预期流程仍是「query embedding → chunk 检索 → 按笔记聚合最佳 chunk」

- `tsconfig.json`
  - TypeScript 的类型检查/编辑器配置文件
  - `npm run build` 会先执行 `tsc -noEmit`：使用该配置做类型检查，但不会产出 `dist/*.js`
  - 实际打包输出由 `esbuild.config.mjs` 生成（产物是 `main.js`，生产构建再复制到 `dist/`）

## 开发约定

1. 优先最小改动，不顺手重构无关部分
2. 涉及行为变化时，同时更新文档
3. 如果 embedding 配置语义发生变化，要考虑索引失效与快照兼容
4. 如果修改了 provider 行为，要检查：
   - `src/settings.ts`
   - `src/main.ts`
   - `docs/ARCHITECTURE.md`
   - `docs/TROUBLESHOOTING.md`

## 索引快照兼容性提示

索引快照会校验关键配置是否一致（不一致会提示用户重建索引），包括：

- `embeddingProvider`
- `remoteBaseUrl`
- `remoteModel`
- `embeddingDimension`
- `chunkingStrategy`（当前为 `paragraph-first-v3-overlap20`）
- `noteVectorStrategy`

## 构建与部署

构建命令：

```bash
npm run build
```

开发时（监听源码并输出 `main.js`）：

```bash
npm run dev
```

部署到 Obsidian 时，复制：

- `main.js` 或 `dist/main.js`
- `manifest.json` 或 `dist/manifest.json`
- `styles.css` 或 `dist/styles.css`

不再有任何本地模型 worker 文件需要复制。

说明：

- 生产构建会先清理 `dist/`，再复制上述 3 个文件到 `dist/`。

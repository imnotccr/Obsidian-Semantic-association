# Semantic Connections 项目架构说明

## 一、项目是什么

一个 Obsidian 插件，为 vault 中的 Markdown 笔记建立**语义索引**，在右侧面板展示与当前笔记最相关的内容——不只是"相关笔记"，还包括笔记中**最契合的一段文字**。同时支持自然语言语义搜索。

---

## 二、整体架构分层

```
┌──────────────────────────────────────────────┐
│              Views Layer（UI 层）             │
│   ConnectionsView（右侧推荐）                │
│   LookupView（语义搜索）                     │
│   只负责渲染和用户交互，不做任何计算          │
├──────────────────────────────────────────────┤
│              Search Layer（搜索层）           │
│   ConnectionsService  → 两阶段关联检索       │
│   LookupService       → 段落级语义搜索       │
│   PassageSelector     → 从候选笔记选最佳段落  │
├──────────────────────────────────────────────┤
│             Indexing Layer（索引层）          │
│   Scanner     → 扫描 vault、读取文件         │
│   Chunker     → 按标题切分为语义块           │
│   ReindexService → 编排索引流程              │
│   ReindexQueue   → 防抖、去重、串行调度      │
├──────────────────────────────────────────────┤
│            Embedding Layer（向量层）          │
│   EmbeddingService → 统一调用入口            │
│   MockProvider     → 开发测试用伪向量        │
│   LocalProvider    → 本地 Transformers.js    │
│   RemoteProvider   → OpenAI 兼容 API         │
├──────────────────────────────────────────────┤
│             Storage Layer（存储层）           │
│   NoteStore   → 笔记元数据                   │
│   ChunkStore  → 语义块元数据                 │
│   VectorStore → 向量存储 + 余弦相似度搜索     │
└──────────────────────────────────────────────┘
```

每一层只依赖下层，不反向依赖，由 `main.ts` 统一组装。

---

## 三、核心数据结构

### NoteMeta（一篇笔记）

```
{
  path: "notes/Python基础.md",    // 唯一标识
  title: "Python基础",            // frontmatter > h1 > 文件名
  mtime: 1709884800000,           // 最后修改时间
  hash: "a1b2c3d4",              // 内容哈希，用于跳过未变文件
  tags: ["python", "tutorial"],
  outgoingLinks: ["notes/OOP.md"],
  summaryText: "Python是一种...", // 前500字，用于生成 note-level 向量
  vector: [0.1, 0.2, ..., 0.15]  // note-level 向量
}
```

### ChunkMeta（一个语义块）

```
{
  chunkId: "notes/Python基础.md#0",  // notePath + # + 序号
  notePath: "notes/Python基础.md",
  heading: "基础概念",               // 该块所在标题
  text: "Python是一种编程语言...",    // 原始文本
  order: 0,                          // 在笔记中的顺序
  vector: [0.05, 0.15, ..., 0.12]   // chunk-level 向量
}
```

### VectorStore 中的存储

```
// 同一个 Map 中混合存储 note 和 chunk 向量，通过 id 格式区分：
"notes/Python基础.md"   → note-level 向量（id 不含 #）
"notes/Python基础.md#0" → chunk-level 向量（id 含 #）
"notes/Python基础.md#1" → chunk-level 向量
```

---

## 四、插件启动流程

```
onload()
 │
 ├─ 1. loadSettings()         读取用户配置
 │
 ├─ 2. createServices()       创建所有服务实例（只做实例化，不做计算）
 │     ├─ ErrorLogger（错误日志，持久化到 error-log.json）
 │     ├─ NoteStore / ChunkStore / VectorStore
 │     ├─ Scanner / Chunker
 │     ├─ EmbeddingService → 根据设置选 MockProvider / LocalProvider / RemoteProvider
 │     ├─ ReindexService（串联 Scanner→Chunker→Embedding→Storage + ErrorLogger）
 │     ├─ ReindexQueue（设置执行器为 ReindexService.processTask）
 │     ├─ ConnectionsService
 │     └─ LookupService
 │
 ├─ 3. registerView()         注册 ConnectionsView 和 LookupView
 ├─ 4. addCommand()           注册 3 个命令
 ├─ 5. addSettingTab()        注册设置页
 │
 └─ 6. onLayoutReady()        Obsidian 布局就绪后：
       ├─ errorLogger.load()          加载错误日志
       ├─ errorLogger.cleanupIfNeeded() 月度清理（删除30天前的日志）
       ├─ registerFileEvents()        监听 create/modify/delete/rename
       └─ if 从未索引 → rebuildIndex()  首次全量索引
```

**关键原则**：`onload()` 保持轻量，所有重计算推迟到 `onLayoutReady` 之后。

---

## 五、索引流程

### 5.1 全量索引

触发时机：首次加载 / 用户手动执行「重建索引」命令

```
rebuildIndex()
 │
 ├─ errorLogger.clear()        清空旧错误日志（日志只保留本次结果）
 │
 └─ ReindexService.indexAll()
 │
 └─ 对每个 .md 文件执行 indexFile()（单文件容错：失败不中断）：
     │
     ├─ 1. Scanner.readContent()       读取文件内容
     ├─ 2. Scanner.buildNoteMeta()     构建笔记元数据
     │      ├─ 提取 title（frontmatter > h1 > 文件名）
     │      ├─ 提取 tags（frontmatter + 正文 #tag）
     │      ├─ 提取 outgoingLinks（[[wikilinks]]）
     │      ├─ 提取 summaryText（正文前500字）
     │      └─ 计算 hash（DJB2 算法）
     │
     ├─ 3. Hash 检查：与已存储的 hash 比较，相同则跳过
     │
     ├─ 4. Chunker.chunk()             按标题切分
     │      ├─ 去掉 frontmatter
     │      ├─ 按 # ~ ###### 标题行分段
     │      └─ 合并过短的段落（< 50 字符）
     │
     ├─ 5. EmbeddingService.embedBatch()  批量生成 chunk 向量
     │      EmbeddingService.embed()      生成 note-level 向量
     │
     ├─ 6. 写入三个 Store
     │      ├─ NoteStore.set(noteMeta)
     │      ├─ ChunkStore.replaceByNote(chunks)
     │      └─ VectorStore.set(id, vector)  ×(N+1)
     │
     └─ [异常] → ErrorLogger.log() 记录错误详情，继续下一个文件
              → indexAll 结束后统一 ErrorLogger.save()
              → 返回 IndexSummary { total, failed }
```

### 5.2 增量索引

触发时机：用户编辑、创建、删除、重命名文件

```
用户编辑文件
  → Obsidian 触发 vault.on('modify')
    → main.ts 捕获事件
      → ReindexQueue.enqueue({ type: 'modify', path })
        → 去重：同 path 的任务只保留最新一条
          → 防抖：1000ms 内无新任务后才执行
            → 串行执行 ReindexService.processTask()

特殊处理：
- delete → 级联删除 NoteStore + ChunkStore + VectorStore 中的数据
- rename → 迁移所有关联数据的 path/id，然后重新索引
```

---

## 六、搜索流程

### 6.1 Connections（右侧关联推荐）——两阶段检索

当用户打开一篇笔记 A 时：

```
第一阶段：note-level 粗筛
 ├─ 取笔记 A 的 note-level 向量
 ├─ 在 VectorStore 中搜索最相似的 note 向量（排除 chunk 向量和自身）
 └─ 返回 40 个候选笔记（取 maxConnections × 2）

第二阶段：chunk-level 精排（PassageSelector）
 ├─ 对每个候选笔记 B：
 │   ├─ 取 B 的所有 chunk 向量
 │   ├─ 取 A 的所有 chunk 向量
 │   ├─ 对 B 的每个 chunk，计算它与 A 所有 chunks 的最大相似度
 │   └─ 选出最大相似度最高的 chunk 作为 bestPassage
 │
 └─ 按 note-level 分数排序，取前 20 条返回
```

**为什么要两阶段？**

- 只用 note-level 向量：能找到相关笔记，但不知道具体哪一段最相关
- 只用 chunk-level 向量：搜索空间太大（每篇笔记多个 chunk），性能差
- 两阶段：先快速缩小范围，再精细选段落，兼顾性能和精度

### 6.2 Lookup（语义搜索）——直接 chunk 级检索

当用户输入查询词时：

```
1. 为查询文本生成 embedding → queryVector

2. 在所有 chunk 向量中搜索（过滤条件：id 包含 #）
   └─ 返回 top 100 个最相似的 chunk

3. 按笔记聚合：同一篇笔记只保留分数最高的 chunk

4. 排序并取前 maxResults 条，每条包含：
   ├─ 笔记标题
   ├─ 相似度分数
   └─ 最佳 passage（标题 + 文本）
```

**为什么 Lookup 不走两阶段？**

因为用户查询是一段短文本，不是一篇完整笔记。没有丰富的 chunk 集合可做精排，直接在 chunk 级搜索更直接有效。

---

## 七、Embedding Provider

### MockProvider（开发测试）

用字符频率统计生成 128 维伪向量。同一文本永远产生相同向量，相似文本有接近的字符分布。不是真正的语义理解，但够跑通全流程。

### LocalProvider（本地推理）

使用 Transformers.js（@huggingface/transformers）+ ONNX Runtime Web 在本地运行 Embedding 模型：

```
特性：
├─ 基于 WASM 后端在 Electron 中运行 ONNX 模型
├─ 懒初始化：首次 embed() 调用时才加载模型
├─ 模型文件缓存在插件数据目录（.obsidian/plugins/.../models/）
├─ 首次使用需从 HuggingFace Hub 下载模型（约 80-200MB）
├─ 支持下载进度回调（通过 Notice 展示进度）
└─ 完全离线运行，无 API 费用
```

预置模型（大小以默认 Q8 量化为准）：

| 模型 ID | 维度 | Q8 大小 | 适用场景 |
|---------|------|---------|----------|
| Xenova/bge-small-zh-v1.5 | 512 | ~24MB | 中文轻量，速度快 |
| Xenova/bge-base-zh-v1.5 | 768 | ~102MB | 中文优化，推荐 |
| Xenova/bge-large-zh-v1.5 | 1024 | ~326MB | 中文高精度，模型较大 |

用户可在设置页选择量化精度（Q8/Q4/FP16/FP32），默认 Q8（最佳的大小与精度平衡）。

### RemoteProvider（生产使用）

调用 OpenAI 兼容的 `/v1/embeddings` 接口：

```
特性：
├─ 按 batchSize 分片请求（默认 100 条/次）
├─ 429（rate limit）/ 5xx 自动退避重试（最多 3 次）
├─ 使用 Obsidian 的 requestUrl（绕过 CORS 限制）
├─ 可配置 Base URL（支持 OpenAI / Azure / 其他兼容服务）
└─ 支持通过 GET /models 自动检测可用的 embedding 模型
```

### 模型列表检测

`RemoteProvider.fetchModels()` 静态方法调用 `GET {apiUrl}/models` 端点，获取 API 支持的模型列表：

```
fetchModels(apiUrl, apiKey)
  → GET {apiUrl}/models
  → 过滤：保留 id 包含 "embed" 的模型
  → 若无匹配：返回全部模型（兼容非标准命名）
  → 按 id 字母序排列
```

设置页通过 `EmbeddingService.fetchAvailableModels()` 调用，结果缓存在 `SettingTab` 实例中。

切换方式：在设置页选择 Provider 类型，从下拉列表选择模型或手动输入。

---

## 八、文件清单

```
src/
├── main.ts                          插件入口，服务组装，事件注册
├── types.ts                         全局类型定义
├── settings.ts                      设置页 UI
│
├── storage/
│   ├── note-store.ts                笔记元数据存储
│   ├── chunk-store.ts               语义块存储（含按笔记的反向索引）
│   ├── vector-store.ts              向量存储 + 暴力余弦搜索
│   └── index.ts
│
├── indexing/
│   ├── scanner.ts                   Vault 文件扫描 + 元数据提取
│   ├── chunker.ts                   Markdown 按标题切分
│   ├── reindex-service.ts           索引编排（扫描→切分→embedding→存储）
│   ├── reindex-queue.ts             任务防抖 + 去重 + 串行调度
│   └── index.ts
│
├── embeddings/
│   ├── provider.ts                  EmbeddingProvider 接口定义
│   ├── mock-provider.ts             开发用字符频率伪向量
│   ├── local-provider.ts            本地 Transformers.js（懒加载 + ONNX 推理）
│   ├── remote-provider.ts           OpenAI 兼容 API（批量 + 重试）
│   ├── embedding-service.ts         Provider 调度层
│   └── index.ts
│
├── search/
│   ├── connections-service.ts       两阶段关联检索
│   ├── lookup-service.ts            段落级语义搜索
│   ├── passage-selector.ts          最佳段落选取
│   └── index.ts
│
├── views/
│   ├── connections-view.ts          右侧关联推荐面板
│   └── lookup-view.ts              语义搜索面板
│
└── utils/
    ├── hash.ts                      DJB2 哈希（变更检测）
    ├── debounce.ts                  防抖工具函数
    └── error-logger.ts              索引错误日志持久化 + 月度清理
```

---

## 九、关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 向量搜索算法 | 暴力遍历 | v1 数据量（<10万向量）下够用，ANN 后续可替换 |
| Chunk 切分规则 | 按标题 + 合并短块 | 简单、直观、保留语义边界 |
| 变更检测方式 | DJB2 哈希 | 快速、碰撞率可接受，避免无变化时重复索引 |
| note 向量来源 | 前 500 字摘要 | 轻量，不需要额外 summarization 模型 |
| Lookup 搜索策略 | 直接 chunk 级 | 查询是短文本，无需 note-level 粗筛 |
| 事件处理 | 防抖 + 去重队列 | 避免高频编辑导致频繁索引 |
| 索引容错 | 单文件 try-catch | 单个文件失败不中断全量索引，错误记录到日志 |
| 错误日志清理 | 启动时懒清理 + 容量上限 | 无需后台定时器，按大小和时间双重控制 |
| 本地 embedding | Transformers.js + ONNX Runtime Web | 无 API 费用；隐私友好；模型体积可控 |

---

## 十、错误日志机制

### 存储位置

```
{vault}/.obsidian/plugins/semantic-connections/error-log.json
```

### 数据格式

```json
{
  "version": 1,
  "lastCleanup": 1709884800000,
  "maxEntries": 500,
  "entries": [
    {
      "timestamp": 1709884800000,
      "filePath": "notes/broken.md",
      "errorType": "embedding",
      "message": "Remote Embedding API error: 401 Unauthorized",
      "provider": "remote"
    }
  ]
}
```

### 错误类型分类

| errorType | 含义 | 典型场景 |
|-----------|------|----------|
| embedding | Embedding API 调用失败 | 网络错误、API Key 无效、速率限制 |
| scanning  | 文件读取 / 元数据提取失败 | 文件被锁定、编码错误 |
| chunking  | 文本切分异常 | 特殊格式导致 Chunker 异常 |
| storage   | 存储写入失败 | 内存不足、数据格式异常 |
| unknown   | 无法分类 | 其他未预期的错误 |

### 清理策略

采用**容量上限 + 时间过期 + 重建清空**三重控制：

1. **容量上限**（500 条）：超过时自动截断最旧的条目
2. **时间过期**（30 天）：启动时执行懒清理，删除 30 天前的条目
3. **重建清空**：每次执行「重建索引」前自动清空旧日志，确保日志只反映最近一次重建
4. **手动清空**：提供 `clear()` 方法供用户重置

### 写入时机

| 场景 | 方法 | 说明 |
|------|------|------|
| 全量索引 | `log()` × N → `save()` × 1 | 批量记录，结束后统一持久化 |
| 增量索引 | `logAndSave()` | 单文件失败后即时持久化 |

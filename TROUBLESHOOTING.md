# 开发问题记录

记录开发过程中遇到的实际问题、根因分析和解决方式。

---

## #001 Obsidian 中索引失败

**日期**：2026-03-08

**现象**：在 Obsidian 中实际使用插件时，执行索引后提示"索引失败，请查看控制台"。

**根因分析**：

经代码审查定位到两个核心问题：

### 问题 A：indexAll 无单文件容错

`ReindexService.indexAll()` 中逐文件调用 `indexFile()`，但没有 try-catch 包裹。任何一个文件的索引失败（如 API 调用异常）都会导致整个 `indexAll()` 抛出异常，中断后续所有文件的索引。

```ts
// 修复前：一个文件失败，全部中断
for (let i = 0; i < files.length; i++) {
    await this.indexFile(files[i]); // ← 这里抛异常就全完了
}
```

### 问题 B：Store 没有持久化

`NoteStore`、`ChunkStore`、`VectorStore` 都有 `load()`/`serialize()` 方法，但 `main.ts` 从未调用它们。每次 Obsidian 启动：

1. 三个 Store 都是空的 `new` 实例
2. `onLayoutReady()` 中 `noteStore.size === 0` 必然为 true
3. 每次启动都触发全量 `rebuildIndex()`
4. 如果 embedding API 有任何问题，全量索引必然失败

**解决方式**：

1. `indexAll()` 添加单文件 try-catch，失败记录到 ErrorLogger，继续下一个文件
2. `indexAll()` 返回 `IndexSummary { total, failed }` 供 UI 展示部分失败
3. 新增 `ErrorLogger` 服务，持久化错误到 `error-log.json`
4. 引入索引快照加载/保存，避免每次启动全量重建

**涉及文件**：

- `src/indexing/reindex-service.ts` — 单文件容错 + ErrorLogger 注入
- `src/utils/error-logger.ts` — 新建
- `src/types.ts` — 新增 `IndexErrorEntry`、`IndexSummary`
- `src/main.ts` — 初始化 ErrorLogger，更新 rebuildIndex 和索引快照逻辑

**状态**：容错和错误日志已修复。索引快照持久化已实现。

---

## #002 错误日志清理策略选择

**日期**：2026-03-08

**现象**：最初采用纯"30 天定期删除"方案，但存在缺陷。

**问题分析**：

纯时间清理的不足：
- 如果 API Key 失效导致 1000 个文件全部失败，30 天内日志会暴增到几千条
- 如果用户长期没有错误，每次启动的清理检查都是浪费

**解决方式**：

改为**容量上限 + 时间过期**双重控制：

| 机制 | 参数 | 作用 |
|------|------|------|
| 容量上限 | MAX_ENTRIES = 500 | 每次 `log()` 时检查，超过则截断最旧条目。实时保护，防暴增 |
| 时间过期 | 30 天 | 启动时懒清理，删除过期条目。周期性清理旧数据 |

两者互补：容量上限防短时间暴增，时间过期清长期累积。

**涉及文件**：

- `src/utils/error-logger.ts` — `log()` 中添加容量截断逻辑

**状态**：已修复。

---

## #010 本地模型测试报错 + 缓存隔离与清理命令

**日期**：2026-03-08

**现象**：测试本地模型时报错 “Cannot read properties of undefined (reading 'create')”。

**根因分析**：

- Transformers.js 在 Electron/Node 环境下会优先选择 `onnxruntime-node`。
- Obsidian 插件环境缺少该原生模块，导致创建 ONNX session 时对象为空。

**解决方式**：

1. ??? `@huggingface/transformers` ???? ORT symbol ??? `process.release.name`??? Transformers.js ? onnxruntime-web/WASM ???
2. 版本化本地模型缓存目录，避免 Transformers.js 升级后新旧模型文件混用：
   `models/cache-v{LOCAL_MODEL_CACHE_VERSION}-tf{TRANSFORMERS_JS_VERSION}`。
3. 新增命令“清理旧本地模型缓存”，清除 `models/` 下除当前缓存外的旧目录/文件。

**涉及文件**：

- `src/embeddings/local-provider.ts` — 预加载 onnxruntime-web + 环境配置
- `src/embeddings/embedding-service.ts` — 版本化缓存路径
- `src/main.ts` — 新增清理缓存命令

**验证步骤**：

1. 设置中选择本地模型，点击“测试本地模型”，应能正常加载/推理。
2. 首次重建索引会下载模型文件，后续应从缓存加载。
3. 执行命令“清理旧本地模型缓存”，确认仅保留当前版本缓存目录。

---


## #011 ?????? Unsupported device: 'cpu'
**??**?2026-03-08

**??**???????????????`Unsupported device: 'cpu'. Should be one of: ...`?
**????**?
- ???? ORT symbol ?? onnxruntime-web??? Transformers.js ? ORT ??????????? `supportedDevices`?
- ?? `device=cpu` ???????? Unsupported device ???

**????**?
1. ?? Transformers.js ??? ORT symbol?????? `process.release.name` ????? Web ?????? onnxruntime-web + wasm ???
2. pipeline ???? `device: "wasm"`??????? cpu?

**????**?
- `src/embeddings/local-provider.ts` ? `importTransformersWebBackend()` + `device: "wasm"`
---


## 待解决问题

暂无。

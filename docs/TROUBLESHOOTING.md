# 常见问题与排查（Troubleshooting）

## #001 启动后没有自动重建索引

现象：

- 插件提示你“需要重建索引”（或索引为空），但启动后不会自动重建
- 手动重建时报“远程配置不完整/缺失”

原因：

这是预期行为：**全量重建需要用户手动触发**，以避免在后台意外消耗远程 Embeddings API。

此外，远程 provider 在重建索引前需要这些配置齐全：

- `API 基础 URL`
- `API 密钥`
- `远程模型`

解决：

1. 填写 `API 基础 URL`
2. 填写 `API 密钥`
3. 确认 `远程模型`
4. 点击 `测试连接`
5. 需要更新索引时，手动执行 `重建索引`

可选：

- 可开启 `自动增量索引`，让插件在文件新增/修改/删除/重命名时自动更新受影响笔记的索引；如果你想主动对整个 Vault 再补扫一遍，可手动执行 `同步变动笔记` 或 `重建索引`。

## #002 “测试连接”成功，但“重建索引”仍失败

现象：

- `测试连接` 成功
- `重建索引` 仍对部分文件失败

原因：

`测试连接` 只验证一次小请求，不覆盖以下情况：

- 实际重建时的批大小（batch size）
- 超长文档
- 复杂/异常的 Markdown 结构
- 最终 `heading + text` payload 的长度约束

建议：

- 查看 `error-log.json` 中的 `filePath` / `stage` / `details`，定位是哪一篇笔记、在哪个阶段失败。

## #003 重建索引报错 `400 invalid parameter`

建议按顺序检查：

1. `errorCode`
2. `stage`
3. `details`

常见的 `details` 线索：

- `status=400`
- `input_count=...`
- `index_mode=full`
- `index_mode=incremental`
- `task_type=modify`

常用的本地错误码：

- `ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID`
- `ERR_INDEX_CHUNK_SPLIT_STALLED`
- `ERR_INDEX_CHUNK_SPLIT_EMPTY`
- `ERR_INDEX_CHUNK_PAYLOAD_EMPTY`
- `ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG`
- `ERR_INDEX_CHUNK_EMBED_REQUEST`
- `ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH`
- `ERR_INDEX_NOTE_EMBED_REQUEST`

推荐排查步骤：

1. 临时把 `批大小（Batch Size）` 调小到 `1`
2. 用错误日志中的 `filePath` 精确定位源文件
3. 检查是否存在超大段落、超长标题、复杂表格、巨型代码块或异常 frontmatter

## #004 为什么扫描结束后才开始报错？

这是正常现象。

全量重建的大致流程是：

1. 扫描文件并收集元数据
2. 切分 chunk
3. 构建最终 `heading + text` payload
4. 发起 embeddings 请求

因此“扫描完成”可能早于 payload 校验或远程请求报错。

## #005 为什么不把 chunk 切得越小越好？

过小的 chunk 通常会降低检索质量：

- 上下文不足
- 更容易匹配到噪声
- 请求次数增加
- 排序稳定性变差

当前策略优先使用段落级 chunk，仅在必要时继续拆分。

## #006 升级后为什么提示“索引快照不兼容”？

通常是某些“兼容性关键字段”发生变化导致的，例如：

- 远程模型
- API 基础 URL
- 向量维度（dimension）
- 切分策略（chunking strategy）
- 笔记向量策略（note vector strategy）

此时请执行 `重建索引`。

## #007 为什么关联排序看起来不稳定？

关联排序不是纯粹的“笔记级向量相似度”。

当前排序口径是：

```text
finalScore = bestPassage.score
```

`passageScore` 仍会通过 log-sum-exp 对多个片段做聚合并暴露出来用于透明化展示，
但 UI 主显示分数跟随“最契合片段”，这样排序结果与用户看到的片段更一致。

## #010 为什么我看到的关联更少，或没有展示段落？

现象：

- 关联结果比预期少
- 有关联笔记出现，但几乎没有可用段落（或段落很少）

原因：

关联结果会先召回候选，再在候选中选择片段并应用软阈值过滤。

如果 `minSimilarityScore` 设得太高，会有更多结果落在阈值下（UI 仍会保留少量 top-N 兜底，并把低于阈值的结果标成“弱关联”）。

解决：

1. 降低相关度阈值（`minSimilarityScore`）
2. 增加 `maxPassagesPerNote`（或设为 `0` 表示不限制）
3. 若怀疑 chunk 向量缺失或过旧，执行 `重建索引` 或对变动笔记执行 `同步变动笔记`

## #008 本地配置或日志会被提交到仓库吗？

不会。

这些已在 `.gitignore` 中忽略：

- `data.json`
- `debug-artifacts/`

## #009 构建与部署

构建命令：

```bash
npm run build
```

部署到 Obsidian 插件目录时，需要复制：

- `main.js` 或 `dist/main.js`
- `manifest.json` 或 `dist/manifest.json`
- `styles.css` 或 `dist/styles.css`

说明：

- 生产构建会在复制前清理 `dist/`，因此 `dist/` 通常只包含上述三个文件。

## #011 日志存在哪里？

插件会把日志写入插件数据目录下的 JSON 文件：

- `error-log.json`
- `runtime-log.json`

路径与 Vault 配置有关，通常位于：

- `.obsidian/plugins/semantic-connections/`


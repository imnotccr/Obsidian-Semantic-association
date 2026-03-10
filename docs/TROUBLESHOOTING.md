# 开发问题记录

## #001 远程 embeddings 配置不完整

**现象**

- 设置页选择了 `remote`
- 启动后没有自动重建索引
- 手动重建时提示远程配置不完整

**原因**

远程 provider 需要同时具备：

- `API Base URL`
- `API Key`
- `Remote Model`

缺少任意一项，都不会真正发起 embeddings 请求。

**处理方式**

1. 在设置页填写 `API Base URL`
2. 填写 `API Key`
3. 确认 `Remote Model`
4. 点击 `Test Connection`
5. 再执行 `重建索引`

## #002 Test Connection 成功，但重建索引失败

**现象**

- `Test Connection` 成功
- 执行 `重建索引` 时，部分文件失败

**原因**

`Test Connection` 只会发送一条很短的测试文本。它只能验证：

- Base URL 可访问
- API Key 可用
- Model 名称可用
- 响应结构基本兼容

它不能覆盖真实索引时的这些情况：

- 批量 `input`
- 长文档切块
- 某篇笔记的特殊格式
- 真实 chunk 长度分布
- 标题上下文和正文拼接后的最终 payload 长度

## #003 重建索引时报 `400 invalid parameter`

**现象**

- `Test Connection` 成功
- 全量重建时出现 `400`
- 错误日志里通常能看到 `stage=response-status`

**优先排查**

1. 看错误日志里的 `errorCode`
2. 看 `stage`
3. 看 `details`

常见的 `details` 包括：

- `status=400`
- `input_count=...`
- `index_mode=full`
- `index_mode=incremental`
- `task_type=modify`

**这次新增的本地错误码**

- `ERR_INDEX_CHUNK_TEXT_LIMIT_INVALID`
  说明：标题上下文占用异常，导致可用正文长度不合法
- `ERR_INDEX_CHUNK_SPLIT_STALLED`
  说明：本地二次拆分没有继续推进
- `ERR_INDEX_CHUNK_SPLIT_EMPTY`
  说明：非空 chunk 被拆分后没有得到有效片段
- `ERR_INDEX_CHUNK_PAYLOAD_EMPTY`
  说明：最终参与 embedding 的 payload 为空
- `ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG`
  说明：最终的 `heading + text` 仍然超过本地限制
- `ERR_INDEX_CHUNK_EMBED_REQUEST`
  说明：chunk embedding 请求失败，但底层 provider 没有给出更具体 code
- `ERR_INDEX_CHUNK_VECTOR_COUNT_MISMATCH`
  说明：返回向量数和 chunk 输入数不一致
- `ERR_INDEX_NOTE_EMBED_REQUEST`
  说明：note summary embedding 请求失败，但底层 provider 没有给出更具体 code

**当前版本已经做的保护**

- chunker 会先剥离 frontmatter，避免 YAML 元数据污染段落向量
- 过滤空 chunk
- 超长段落二次拆分
- embedding 输入自动带上 `heading + text`
- 最终发送前会再按真实 `heading + text` 长度做一次保护，必要时继续拆分
- 空批次不会继续请求远程 API

**建议排查顺序**

1. 如果 `input_count` 很大，先把 `Batch Size` 临时改成 `1`
2. 如果仍失败，优先怀疑某些段落仍然超出服务端限制
3. 用错误日志里的 `filePath` 定位具体文件
4. 如果 `errorCode` 是 `ERR_INDEX_CHUNK_PAYLOAD_TOO_LONG`、`ERR_INDEX_CHUNK_SPLIT_STALLED` 或 `ERR_INDEX_CHUNK_SPLIT_EMPTY`，优先看本地切块和长度保护
5. 检查该文件是否有超长连续段落、超长标题链、表格、代码块或异常 frontmatter

**按 `stage` 快速定位**

- `provider-config`
  先看设置页里的 `API Base URL`、`API Key`、`Remote Model`、`Timeout`、`Batch Size`
- `request-send` 或 `request-timeout`
  先怀疑网络、反代、超时或目标服务不可达
- `response-status`
  说明服务端已收到请求，但拒绝了参数或内部出错
- `response-json`、`response-data`、`response-embedding`、`response-dimension`
  说明返回体结构和插件预期不一致，不是纯粹的网络问题
- `chunk-embedding-limit`、`chunk-embedding-split`、`chunk-embedding-validate`
  说明错误发生在本地最终 payload 构造或长度保护阶段
- `chunk-embedding-request`、`chunk-embedding-response`
  说明批量 chunk 请求发出后失败，或返回数量和发送数量不一致
- `note-embedding-request`
  说明 chunk 可能已经通过，但 note summary 的单条 embedding 失败

## #004 为什么目录文件都处理完了才报错

这是当前流程的正常表现，不表示目录扫描本身有问题。

重建索引不是“边扫目录边立刻请求远程 API”，而是大致分成两段：

1. 先扫描文件、提取元数据、切块
2. 再构造最终 `heading + text` payload，并发起 chunk / note 的 embeddings 请求

所以你看到“目录文件已经处理完了，最后才报错”，通常意味着：

- 扫描阶段已经完成
- 真正失败的是后面的本地 payload 校验、二次拆分、远程请求或响应校验

这类情况优先看错误日志里的：

- `errorCode`
- `stage`
- `details`

## #005 为什么不是切得越细越好

不是。

切得过细通常会带来这些副作用：

- 每个 chunk 的语义上下文不足
- 相似度更容易被局部词汇噪声主导
- 候选 passage 会更多，但质量不稳定
- 请求次数、索引体积和排序抖动都会增加

当前实现采取的是折中策略：

- 优先按段落切
- 太短的段落会并到相邻段落
- 太长的段落才继续细分
- 标题不直接混进正文展示，但会参与 embedding 上下文

这比“固定长度硬切”更接近真正的语义边界。

## #006 升级后提示快照不兼容

**现象**

- 插件启动时跳过磁盘快照
- 提示需要手动 `重建索引`

**原因**

当前快照除了 embedding 配置，还会记录：

- `chunkingStrategy`

当切块策略从旧版切换到 `paragraph-first-v2` 时，旧快照里的 chunk 已经不再可信，所以会被判定为不兼容。

**这属于预期行为**

执行一次 `重建索引` 即可。

## #007 关联结果排序看起来不稳定

当前 `ConnectionsService` 已经不是纯 note-level 排序，而是：

```text
finalScore = noteScore * 0.7 + passageScore * 0.3
```

这意味着：

- 整篇笔记整体相似，但没有好的段落对齐，排名会被拉低
- 某个局部段落非常接近，但整篇主题不一致，也不会直接冲到最前

如果要排查某条结果为什么排在当前位置，可以在 Connections View 里 hover 分数，查看：

- 综合分
- note 分
- passage 分

## #008 本地配置和日志文件是否会入库

不会。

以下文件/目录已被 `.gitignore` 忽略：

- `data.json`
- `debug-artifacts/`

其中：

- `data.json` 用于本地保存远程 API Base URL / API Key 等测试配置
- `debug-artifacts/` 用于保存你手工收集的运行日志和错误日志

## #009 构建与部署

**构建**

```bash
npm run build
```

**需要部署到 Obsidian 插件目录的文件**

- `main.js` 或 `dist/main.js`
- `manifest.json` 或 `dist/manifest.json`
- `styles.css` 或 `dist/styles.css`

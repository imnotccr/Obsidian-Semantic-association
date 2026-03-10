# CLAUDE.md

## 项目定位

这是一个 Obsidian 语义索引插件。

当前 embedding 方案只有两种：

- `remote`: OpenAI 兼容 `/v1/embeddings` 接口
- `mock`: 开发测试用伪向量

本地模型相关实现已经移除。

## 当前约束

1. 插件内部只处理单一 dense 向量 `number[]`
2. 默认远程模型是 `BAAI/bge-m3`
3. 不支持 sparse embedding
4. 不支持 ColBERT / multi-vector
5. 不要重新引入 Transformers.js、本地 worker、模型缓存，除非用户明确要求

## 关键文件

- `src/main.ts`
  - 插件入口
  - 设置加载
  - 索引快照加载/保存
  - 命令注册
  - 重建索引

- `src/settings.ts`
  - 设置页
  - `remote/mock` provider 切换
  - 远程 API 配置
  - Test Connection

- `src/embeddings/remote-provider.ts`
  - OpenAI 兼容 embeddings 请求
  - 超时、HTTP、JSON、缺字段、维度不一致等错误处理

- `src/embeddings/embedding-service.ts`
  - provider 创建与切换

- `src/indexing/`
  - 扫描、切块、重建索引、增量索引

- `src/storage/`
  - note/chunk/vector store

## 开发约定

1. 优先最小改动，不顺手重构无关部分
2. 涉及行为变化时，同时更新文档
3. 如果 embedding 配置语义发生变化，要考虑索引失效与快照兼容
4. 如果修改了 provider 行为，要检查：
   - `src/settings.ts`
   - `src/main.ts`
   - `docs/ARCHITECTURE.md`
   - `docs/TROUBLESHOOTING.md`

## 构建与部署

构建命令：

```bash
npm run build
```

部署到 Obsidian 时，复制：

- `main.js` 或 `dist/main.js`
- `manifest.json` 或 `dist/manifest.json`
- `styles.css` 或 `dist/styles.css`

不再有任何本地模型 worker 文件需要复制。

# Semantic Connections

一个 Obsidian 插件，为你的笔记库建立语义索引，自动发现笔记之间的隐藏关联，并精准定位到最相关的段落。

## 功能

### Connections View（右侧关联面板）

打开任意笔记，右侧自动展示：

- 与当前笔记最相关的其他笔记
- 每篇相关笔记中**最契合的一段文字**
- 相似度评分

### Lookup View（语义搜索）

输入自然语言查询：

- 在整个笔记库中进行段落级语义搜索
- 返回最相关的笔记片段，而非仅匹配关键词
- 支持防抖输入，回车即搜

### 增量索引

- 自动监听文件的创建、修改、删除、重命名
- 防抖去重，不影响日常编辑体验
- 内容未变化时自动跳过（基于哈希检测）

## 安装

1. 将本项目文件夹复制到 vault 的 `.obsidian/plugins/semantic-connections/` 目录下
2. 在 Obsidian 设置 → 第三方插件 中启用 **Semantic Connections**
3. 在插件设置中配置 Embedding 模型

## 配置

在 Obsidian 设置 → Semantic Connections 中：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| 最大关联数 | 右侧展示的相关笔记数量 | 20 |
| 自动索引 | 文件变更时自动更新索引 | 开启 |
| Embedding 模型 | Mock（测试）/ 远程 API | Mock |
| 排除文件夹 | 不参与索引的目录 | 无 |

### 远程 API 配置

选择「远程 API」后，需要填写：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| API Key | OpenAI 或兼容服务的密钥 | - |
| API Base URL | 兼容 OpenAI 格式的地址 | `https://api.openai.com/v1` |
| 模型名称 | Embedding 模型 ID | `text-embedding-3-small` |
| 批量大小 | 单次请求最大文本数 | 100 |

支持任何 OpenAI 兼容的 Embedding API（Azure OpenAI、together.ai 等），只需修改 Base URL。

## 使用

1. **首次使用**：启用插件后会自动执行全量索引（也可通过命令手动触发）
2. **查看关联**：打开任意笔记，在右侧面板查看语义关联
3. **语义搜索**：通过命令面板打开 Lookup View，输入查询词

### 命令

| 命令 | 说明 |
|------|------|
| `Semantic Connections: 打开关联视图` | 在右侧打开 Connections 面板 |
| `Semantic Connections: 打开语义搜索` | 打开 Lookup 搜索面板 |
| `Semantic Connections: 重建索引` | 重新扫描全部笔记并构建索引 |

## 技术架构

详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```
src/
├── main.ts                  插件入口
├── types.ts                 类型定义
├── settings.ts              设置页
├── storage/                 存储层（笔记、语义块、向量）
├── indexing/                索引层（扫描、切分、队列、编排）
├── embeddings/              向量层（Provider 接口、Mock、Remote）
├── search/                  搜索层（关联检索、语义搜索、段落选取）
├── views/                   视图层（Connections、Lookup）
└── utils/                   工具函数
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化自动构建）
npm run dev

# 生产构建
npm run build
```

## 许可证

MIT

/**
 * 插件设置页
 *
 * 提供用户可配置项：
 * - 最大关联数
 * - 排除文件夹
 * - Embedding Provider 选择
 * - 自动索引开关
 */

import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import type { LocalDtype, RemoteModelInfo } from "./types";
import { SUPPORTED_LOCAL_MODELS } from "./embeddings/local-provider";

/** 手动输入模型的特殊标记值 */
const MANUAL_MODEL_VALUE = "__manual__";

/** dtype 下拉选项（按推荐度排序） */
const DTYPE_OPTIONS: { value: string; label: string }[] = [
	{ value: "q8", label: "Q8（8-bit 量化，推荐）" },
	{ value: "q4", label: "Q4（4-bit 量化，最小）" },
	{ value: "fp16", label: "FP16（半精度）" },
	{ value: "fp32", label: "FP32（全精度，最大）" },
];

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

	/** 缓存的远程模型列表（避免每次 display() 都拉取） */
	private cachedModels: RemoteModelInfo[] | null = null;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Semantic Connections 设置" });

		// 最大关联数
		new Setting(containerEl)
			.setName("最大关联数")
			.setDesc("右侧视图展示的最大相关笔记数量")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.maxConnections)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxConnections = value;
						await this.plugin.saveSettings();
					})
			);

		// 自动索引开关
		new Setting(containerEl)
			.setName("自动索引")
			.setDesc("文件变更时自动更新索引")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					})
			);

		// Embedding Provider
		new Setting(containerEl)
			.setName("Embedding 模型")
			.setDesc("选择向量生成方式")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mock", "Mock（开发测试）")
					.addOption("local", "本地模型（Transformers.js）")
					.addOption("remote", "远程 API（OpenAI 兼容）")
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						const prevProvider = this.plugin.settings.embeddingProvider;
						this.plugin.settings.embeddingProvider = value as "mock" | "local" | "remote";
						await this.plugin.saveSettings();

						// 运行时切换 provider（否则需要重启插件才生效）
						this.plugin.embeddingService.switchProvider(this.plugin.settings);

						// provider 变化时，旧索引向量维度/语义不再兼容，必须重建
						if (prevProvider !== this.plugin.settings.embeddingProvider) {
							this.plugin.noteStore.clear();
							this.plugin.chunkStore.clear();
							this.plugin.vectorStore.clear();
							new Notice("Embedding 模型已切换，索引已清空。请执行「重建索引」重新生成向量。", 8000);
						}

						// 切换 provider 后清空模型缓存（不同 provider 的模型列表不同）
						this.cachedModels = null;

						// 重新渲染设置页以显示/隐藏对应配置项
						this.display();
					})
			);

		// 仅在选择 remote 时显示 API 配置项
		if (this.plugin.settings.embeddingProvider === "remote") {
			new Setting(containerEl)
				.setName("API Key")
				.setDesc("OpenAI 或兼容服务的 API Key")
				.addText((text) =>
					text
						.setPlaceholder("sk-...")
						.setValue(this.plugin.settings.remoteApiKey)
						.onChange(async (value) => {
							this.plugin.settings.remoteApiKey = value.trim();
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							// API Key 变更后清空模型缓存（不同 Key 可用的模型可能不同）
							this.cachedModels = null;
						})
				);

			new Setting(containerEl)
				.setName("API Base URL")
				.setDesc("兼容 OpenAI 格式的 API 地址（无需以 /embeddings 结尾）")
				.addText((text) =>
					text
						.setPlaceholder("https://api.openai.com/v1")
						.setValue(this.plugin.settings.remoteApiUrl)
						.onChange(async (value) => {
							this.plugin.settings.remoteApiUrl = value.trim();
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							// URL 变更后清空模型缓存
							this.cachedModels = null;
							new Notice("API Base URL 已更新；如切换了服务商/部署，建议执行「重建索引」。", 6000);
						})
				);

			// ── 模型选择（dropdown + 刷新按钮 + 手动输入 fallback） ──
			this.renderModelSetting(containerEl);

			new Setting(containerEl)
				.setName("批量大小")
				.setDesc("单次 API 请求最大文本数（建议 50-100）")
				.addSlider((slider) =>
					slider
						.setLimits(10, 200, 10)
						.setValue(this.plugin.settings.remoteBatchSize)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.remoteBatchSize = value;
							await this.plugin.saveSettings();
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
						})
				);

			// 测试 API 连接
			const testSetting = new Setting(containerEl)
				.setName("测试连接")
				.setDesc("发送一条测试请求，验证 API 配置是否有效")
				.addButton((btn) => {
					btn
						.setButtonText("测试")
						.onClick(async () => {
							btn.setButtonText("测试中...");
							btn.setDisabled(true);

							// 确保使用最新配置
							this.plugin.embeddingService.switchProvider(this.plugin.settings);
							const result = await this.plugin.embeddingService.testConnection();

							// 移除旧的测试结果
							testSetting.descEl.querySelector(".sc-api-test-result")?.remove();

							const resultEl = testSetting.descEl.createEl("div", {
								cls: "sc-api-test-result",
							});

							if (result.ok) {
								resultEl.addClass("is-success");
								resultEl.setText(`连接成功（向量维度：${result.dimension}）`);
							} else {
								resultEl.addClass("is-error");
								resultEl.setText(`连接失败：${result.error}`);
							}

							btn.setButtonText("测试");
							btn.setDisabled(false);
						});
				});
		}

		// 仅在选择 local 时显示本地模型配置项
		if (this.plugin.settings.embeddingProvider === "local") {
			this.renderLocalModelSettings(containerEl);
		}

		// 排除文件夹
		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("不参与索引的文件夹路径，每行一个")
			.addTextArea((text) =>
				text
					.setPlaceholder("templates\narchive")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
						new Notice("排除文件夹设置已更新；建议执行「重建索引」以清理/重建索引结果。", 6000);
					})
			);

		// ── 索引管理 ──
		containerEl.createEl("h2", { text: "索引管理" });

		const noteCount = this.plugin.noteStore.size;
		const chunkCount = this.plugin.chunkStore.size;
		const statusText = noteCount > 0
			? `当前索引：${noteCount} 篇笔记，${chunkCount} 个语义块`
			: "当前无索引数据";

		const rebuildSetting = new Setting(containerEl)
			.setName("重建索引")
			.setDesc(statusText)
			.addButton((btn) => {
				btn
					.setButtonText(this.plugin.isRebuilding ? "正在重建..." : "重建索引")
					.setCta()
					.setDisabled(this.plugin.isRebuilding)
					.onClick(async () => {
						btn.setButtonText("正在重建...");
						btn.setDisabled(true);
						await this.plugin.rebuildIndex();
						// 重建完成后刷新设置页，更新索引计数
						this.display();
					});
			});

		// 如果有错误日志，追加提示
		const errorCount = this.plugin.errorLogger.size;
		if (errorCount > 0) {
			rebuildSetting.descEl.createEl("br");
			rebuildSetting.descEl.createEl("span", {
				text: `错误日志：${errorCount} 条`,
				cls: "sc-setting-error-hint",
			});
		}
	}

	/**
	 * 渲染模型选择控件
	 *
	 * 组合 UI：dropdown + 刷新按钮 + 手动输入 fallback
	 *
	 * 交互流程：
	 * 1. 设置页打开时，如果 API Key 和 URL 已配置，异步拉取模型列表
	 * 2. 拉取成功后填充 dropdown（过滤后只展示 embedding 模型）
	 * 3. 拉取失败或用户选择「手动输入」时，显示文本输入框
	 * 4. 刷新按钮清空缓存并重新拉取
	 *
	 * 为什么将此逻辑独立为方法？
	 * - 模型选择的 UI 和状态管理比其他设置项复杂
	 * - 涉及异步拉取、缓存、条件渲染等逻辑
	 * - 独立方法便于维护，不污染 display() 主流程
	 */
	private renderModelSetting(containerEl: HTMLElement): void {
		const modelSetting = new Setting(containerEl)
			.setName("Embedding 模型")
			.setDesc("选择或输入 Embedding 模型 ID");

		// 手动输入文本框的容器（条件显示）
		let manualInputEl: HTMLElement | null = null;

		// 当前是否处于手动输入模式
		const currentModel = this.plugin.settings.remoteModel;
		let isManualMode = false;
		let manualInputValue = this.plugin.settings.remoteModel;
		let manualText: TextComponent | null = null;

		/**
		 * 应用模型变更
		 * 抽取公共逻辑：更新设置、切换 provider、清空索引
		 */
		const applyModelChange = async (newModel: string): Promise<void> => {
			const prevModel = this.plugin.settings.remoteModel;
			this.plugin.settings.remoteModel = newModel;
			await this.plugin.saveSettings();
			this.plugin.embeddingService.switchProvider(this.plugin.settings);

			if (prevModel !== newModel && prevModel !== "" && newModel !== "") {
				this.plugin.noteStore.clear();
				this.plugin.chunkStore.clear();
				this.plugin.vectorStore.clear();
				new Notice("Embedding 模型名称已变更，索引已清空。请执行「重建索引」。", 8000);
			}
		};

		const applyManualModel = async (): Promise<void> => {
			const trimmed = manualInputValue.trim();
			if (!trimmed) return;
			manualInputValue = trimmed;
			await applyModelChange(trimmed);
		};

		// ── 添加 dropdown ──
		modelSetting.addDropdown((dropdown) => {
			const selectEl = dropdown.selectEl;

			// 初始状态：先放入当前值 + 手动输入选项
			if (currentModel) {
				selectEl.createEl("option", {
					value: currentModel,
					text: currentModel,
				});
			}
			selectEl.createEl("option", {
				value: MANUAL_MODEL_VALUE,
				text: "✎ 手动输入...",
			});
			dropdown.setValue(currentModel || MANUAL_MODEL_VALUE);

			// 选择变更处理
			dropdown.onChange(async (value) => {
				if (value === MANUAL_MODEL_VALUE) {
					isManualMode = true;
					if (manualInputEl) manualInputEl.show();
					if (manualText) {
						const current = this.plugin.settings.remoteModel;
						manualInputValue = current || "";
						manualText.setValue(current || manualInputValue || "");
					}
				} else {
					isManualMode = false;
					if (manualInputEl) manualInputEl.hide();
					await applyModelChange(value);
				}
			});

			// 异步加载模型列表
			// 只要求 URL 非空即可发起模型拉取（部分本地/免费服务不需要 API Key）
			const canFetch = !!this.plugin.settings.remoteApiUrl;

			if (canFetch) {
				if (this.cachedModels) {
					// 有缓存：直接填充
					this.populateModelDropdown(selectEl, this.cachedModels);
					dropdown.setValue(currentModel || MANUAL_MODEL_VALUE);
				} else {
					// 无缓存：异步拉取
					this.fetchAndPopulateModels(selectEl, dropdown, modelSetting);
				}
			}
		});

		// ── 添加刷新按钮 ──
		modelSetting.addExtraButton((btn) => {
			btn
				.setIcon("refresh-cw")
				.setTooltip("刷新模型列表")
				.onClick(async () => {
					this.cachedModels = null;
					this.display();
				});
		});

		// ── 添加手动输入文本框（默认隐藏） ──
		manualInputEl = modelSetting.controlEl.createEl("div", {
			cls: "sc-manual-model-input",
		});
		const manualInput = new Setting(manualInputEl)
			.addText((text) => {
				manualText = text;
				text
					.setPlaceholder("text-embedding-3-small")
					.setValue(this.plugin.settings.remoteModel || "")
					.onChange((value) => {
						manualInputValue = value;
					});

				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void applyManualModel();
					}
				});
			})
			.addButton((btn) => {
				btn
					.setButtonText("应用")
					.onClick(async () => {
						await applyManualModel();
					});
			});
		// 去掉嵌套 Setting 的默认边距
		manualInput.settingEl.style.border = "none";
		manualInput.settingEl.style.padding = "0";

		if (!isManualMode) {
			manualInputEl.hide();
		}
	}

	/**
	 * 渲染本地模型配置区块
	 *
	 * 仅在 embeddingProvider === "local" 时显示。
	 * 包含模型选择 dropdown 和测试按钮。
	 */
	private renderLocalModelSettings(containerEl: HTMLElement): void {
		// 模型选择 dropdown
		new Setting(containerEl)
			.setName("本地模型")
			.setDesc("选择用于本地 Embedding 的模型（首次使用时将自动下载）")
			.addDropdown((dropdown) => {
				for (const model of SUPPORTED_LOCAL_MODELS) {
					dropdown.addOption(model.id, model.name);
				}
				dropdown.setValue(this.plugin.settings.localModelId);
				dropdown.onChange(async (value) => {
					const prevModel = this.plugin.settings.localModelId;
					this.plugin.settings.localModelId = value;
					await this.plugin.saveSettings();
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevModel !== value) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice("本地模型已切换，索引已清空。请执行「重建索引」。", 8000);
					}

					this.display();
				});
			});

		// 量化精度选择
		new Setting(containerEl)
			.setName("量化精度")
			.setDesc("模型量化等级，影响下载大小和推理精度")
			.addDropdown((dropdown) => {
				for (const opt of DTYPE_OPTIONS) {
					dropdown.addOption(opt.value, opt.label);
				}
				dropdown.setValue(this.plugin.settings.localDtype);
				dropdown.onChange(async (value) => {
					const prevDtype = this.plugin.settings.localDtype;
					this.plugin.settings.localDtype = value as LocalDtype;
					await this.plugin.saveSettings();
					this.plugin.embeddingService.switchProvider(this.plugin.settings);

					if (prevDtype !== value) {
						this.plugin.noteStore.clear();
						this.plugin.chunkStore.clear();
						this.plugin.vectorStore.clear();
						new Notice("量化精度已切换，索引已清空。请执行「重建索引」。", 8000);
					}

					this.display();
				});
			});

		// 当前选中模型的描述（含动态下载大小）
		const selectedModel = SUPPORTED_LOCAL_MODELS.find(
			(m) => m.id === this.plugin.settings.localModelId,
		);
		if (selectedModel) {
			const currentDtype = this.plugin.settings.localDtype;
			const sizeHint = selectedModel.sizeHints[currentDtype] ?? selectedModel.sizeHints["q8"];
			new Setting(containerEl)
				.setName("模型信息")
				.setDesc(`${selectedModel.description}（维度：${selectedModel.dimension}，预计下载：${sizeHint}）`);
		}

		// 测试按钮
		const testSetting = new Setting(containerEl)
			.setName("测试本地模型")
			.setDesc("加载模型并执行一次测试推理（首次可能需要下载模型文件）")
			.addButton((btn) => {
				btn
					.setButtonText("测试")
					.onClick(async () => {
						btn.setButtonText("加载中...");
						btn.setDisabled(true);

						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						const result = await this.plugin.embeddingService.testConnection();

						testSetting.descEl.querySelector(".sc-local-test-result")?.remove();

						const resultEl = testSetting.descEl.createEl("div", {
							cls: "sc-local-test-result",
						});

						if (result.ok) {
							resultEl.addClass("is-success");
							resultEl.setText(`模型加载成功（向量维度：${result.dimension}）`);
						} else {
							resultEl.addClass("is-error");
							resultEl.setText(`模型加载失败：${result.error}`);
						}

						btn.setButtonText("测试");
						btn.setDisabled(false);
					});
			});
	}

	/**
	 * 异步拉取模型列表并填充 dropdown
	 *
	 * 拉取期间在 Setting 描述区域显示加载提示。
	 * 成功后缓存结果，失败后显示错误提示。
	 *
	 * @param selectEl - dropdown 的原生 select 元素
	 * @param dropdown - Obsidian Dropdown 组件实例
	 * @param setting - 所属的 Setting 组件（用于显示状态提示）
	 */
	private async fetchAndPopulateModels(
		selectEl: HTMLSelectElement,
		dropdown: { setValue: (value: string) => void },
		setting: Setting,
	): Promise<void> {
		// 显示加载状态
		const hintEl = setting.descEl.createEl("div", {
			cls: "sc-model-fetch-hint",
			text: "正在获取可用模型...",
		});

		const result = await this.plugin.embeddingService.fetchAvailableModels();

		hintEl.remove();

		if (result.ok && result.models.length > 0) {
			this.cachedModels = result.models;
			this.populateModelDropdown(selectEl, result.models);
			dropdown.setValue(this.plugin.settings.remoteModel || MANUAL_MODEL_VALUE);
		} else {
			// 拉取失败或列表为空：显示提示
			const errorText = result.ok
				? "未检测到可用模型"
				: `获取模型列表失败：${result.error}`;
			setting.descEl.createEl("div", {
				cls: "sc-model-fetch-hint is-error",
				text: errorText,
			});
		}
	}

	/**
	 * 填充远程模型 dropdown 选项（统一入口，避免重复代码）
	 *
	 * 1. 清空现有选项
	 * 2. 添加从 API 获取的模型
	 * 3. 如果当前选中的模型不在列表中，追加为额外选项
	 * 4. 追加「手动输入」选项
	 */
	private populateModelDropdown(
		selectEl: HTMLSelectElement,
		models: RemoteModelInfo[],
	): void {
		const currentModel = this.plugin.settings.remoteModel;

		selectEl.empty();

		for (const model of models) {
			const option = selectEl.createEl("option", {
				value: model.id,
				text: model.id,
			});
			if (model.id === currentModel) {
				option.selected = true;
			}
		}

		// 当前模型不在列表中时，添加额外选项确保不丢失
		const inList = models.some((m) => m.id === currentModel);
		if (currentModel && !inList) {
			const option = selectEl.createEl("option", {
				value: currentModel,
				text: `${currentModel}（当前）`,
			});
			option.selected = true;
		}

		selectEl.createEl("option", {
			value: MANUAL_MODEL_VALUE,
			text: "✎ 手动输入...",
		});
	}
}

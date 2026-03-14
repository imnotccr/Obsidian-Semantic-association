/**
 * 插件设置页（Settings Tab）。
 *
 * Obsidian 会在“设置 -> 第三方插件 -> 本插件”打开时调用 `display()`。
 * 本文件负责把所有可配置项渲染成 UI，并把用户输入安全地写回 `plugin.settings`。
 *
 * 代码结构（建议你按这个顺序阅读）：
 * 1) `display()`：清空容器并依次渲染各个 section
 * 2) `renderRemoteSettings()`：远程 embeddings 配置 + 测试连接按钮
 * 3) `renderBehaviorSettings()`：行为设置（是否监听文件变动、是否启动自动打开视图）
 * 4) `renderConnectionsSettings()`：关联视图展示相关（阈值、条数、段落数等）
 * 5) `renderIndexManagement()`：索引管理（重建、查看存储统计等）
 *
 * 保存策略（学习时重点看 `saveSettingsOrRollback()`）：
 * - 先更新 `plugin.settings`（内存态）
 * - 再调用 `plugin.saveSettings()` 写入磁盘（data.json）
 * - 如果写入失败：回滚到旧值，并用 Notice 提示用户
 *
 * 兼容性策略：
 * - 像 remoteBaseUrl / remoteModel 这种会改变向量语义或维度的设置，一旦变更，旧索引快照通常不再可用；
 *   因此会调用 `invalidateIndex()` 清空索引并提示用户重建。
 */

import { App, Notice, PluginSettingTab, Setting, SliderComponent, TextComponent } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import {
	DEFAULT_SETTINGS,
	type RebuildIndexProgress,
} from "./types";
import { normalizeRemoteBaseUrl } from "./embeddings/remote-provider";

/**
 * Obsidian 设置面板中的 Tab。
 *
 * 该类只负责两件事：
 * 1) 渲染各种 Setting 控件（输入框、开关、滑块、按钮等）
 * 2) 把用户输入写回 `plugin.settings` 并持久化（失败则回滚）
 *
 * 真正的业务逻辑（重建索引、测试连接、清空日志等）都委托给 `SemanticConnectionsPlugin` 去完成。
 */
export class SettingTab extends PluginSettingTab {
	/** 主插件实例：用于读写 settings，并调用业务方法（rebuildIndex / syncNotes / ...）。 */
	private plugin: SemanticConnectionsPlugin;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Obsidian 在打开设置页、或你主动刷新 SettingTab 时会调用它。
	 *
	 * 这里选择“每次都重新渲染全部内容”：
	 * - 状态更简单（不用维护一堆组件引用）
	 * - 当保存失败需要回滚时，直接重新渲染即可保证 UI 与 settings 一致
	 */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "语义关联设置" });
		// 1) 远程 embeddings 配置（会影响向量维度/质量，因此与索引兼容性强相关）
		this.renderRemoteSettings(containerEl);

		// 2) 排除目录：这些目录下的笔记不会被扫描/索引/检索
		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("每行填写一个文件夹路径。索引时会跳过这些文件夹。")
			.addTextArea((text) =>
				text
					.setPlaceholder("templates\narchive")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						const previousValue = [...this.plugin.settings.excludedFolders];
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((item) => item.trim())
							.filter((item) => item.length > 0);
						const saved = await this.saveSettingsOrRollback("excluded-folders", () => {
							this.plugin.settings.excludedFolders = previousValue;
						});
						if (saved) {
							new Notice(
								"排除文件夹已更新。搜索/关联结果会立即过滤；若要从索引存储中彻底移除，请重建索引。",
								6000,
							);
						}
					}),
			);

		// 3) 行为设置：自动打开视图、是否监听文件变化（仅标记 dirty，不会自动请求 API）
		this.renderBehaviorSettings(containerEl);
		// 4) 关联视图相关：展示数量、阈值、每篇最多展示多少段落等
		this.renderConnectionsSettings(containerEl);
		// 5) 索引管理：重建索引、查看存储、失败任务重试等
		this.renderIndexManagement(containerEl);
	}

	/**
	 * 渲染“行为”设置 section。
	 *
	 * 这里的设置会影响插件在后台做什么：
	 * - `autoOpenConnectionsView`：启动后自动打开关联视图（不抢焦点）
	 * - `autoIndex`：监听 vault 文件变动；注意这里只是标记 dirty/outdated，不会自动调用远程 embeddings
	 */
	private renderBehaviorSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "行为" });

		new Setting(containerEl)
			.setName("启动时自动打开右侧关联视图")
			.setDesc("开启后插件启动完成时会自动在右侧边栏创建“语义关联”视图（不会抢编辑器焦点）。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoOpenConnectionsView).onChange(async (value) => {
					const previousValue = this.plugin.settings.autoOpenConnectionsView;
					this.plugin.settings.autoOpenConnectionsView = value;
					const saved = await this.saveSettingsOrRollback(
						"auto-open-connections-view",
						() => {
							this.plugin.settings.autoOpenConnectionsView = previousValue;
						},
						{ refresh: false },
					);

					if (!saved) {
						toggle.setValue(previousValue);
						return;
					}
				}),
			);

		new Setting(containerEl)
			.setName("监听文件变更（仅本地标记）")
			.setDesc(
				"开启后会监听笔记新增/修改/删除/重命名：新增/修改仅计算 Hash 并标记为待同步，不会自动调用 Embedding API。需要手动执行“同步变动笔记”或在关联视图点击“立即同步”才会消耗 API。",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoIndex).onChange(async (value) => {
					const previousValue = this.plugin.settings.autoIndex;
					this.plugin.settings.autoIndex = value;
					const saved = await this.saveSettingsOrRollback(
						"auto-index",
						() => {
							this.plugin.settings.autoIndex = previousValue;
						},
						{ refresh: false },
					);

					if (!saved) {
						toggle.setValue(previousValue);
						return;
					}

					new Notice(
						value
							? "已开启变动标记：文件变更将被标记为待同步（不自动调用 API）。"
							: "已关闭变动标记：文件变更不会自动标记，可手动执行“同步变动笔记”。",
						6000,
					);
				}),
			);
	}

	/**
	 * 渲染“远程嵌入（Remote Embeddings）”设置 section。
	 *
	 * 该 section 控制 `EmbeddingService` 的 remote provider：
	 * - base URL：会被 `normalizeRemoteBaseUrl()` 归一化，最终请求 `{baseUrl}/v1/embeddings`
	 * - API key：以 `Authorization: Bearer <key>` 形式发送
	 * - model/timeout/batch size：控制请求参数
	 *
	 * 其中 baseUrl/model 的变更通常会让旧索引快照不再兼容，因此会调用 `invalidateIndex()` 清空索引并提示重建。
	 */
	private renderRemoteSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "远程嵌入" });

		new Setting(containerEl)
			.setName("API 基础 URL")
			.setDesc("请求将发送到 {baseUrl}/v1/embeddings。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteBaseUrl;
					const nextValue = normalizeRemoteBaseUrl(text.getValue());
					this.plugin.settings.remoteBaseUrl = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-base-url",
						() => {
							this.plugin.settings.remoteBaseUrl = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteBaseUrl);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
					if (previousValue !== nextValue) {
						this.invalidateIndex(
							"远程 API 基础 URL 已变更，现有索引已清空，请重新构建索引。",
						);
					}
				};

				text
					.setPlaceholder("https://your-api.example.com")
					.setValue(this.plugin.settings.remoteBaseUrl);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("API 密钥")
			.setDesc("用于远程嵌入 API 的 Bearer Token。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteApiKey;
					const nextValue = text.getValue().trim();
					this.plugin.settings.remoteApiKey = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-api-key",
						() => {
							this.plugin.settings.remoteApiKey = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteApiKey);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder("sk-...").setValue(this.plugin.settings.remoteApiKey);
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.inputEl.spellcheck = false;
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("远程模型")
			.setDesc("稠密向量模型名称，默认使用 BAAI/bge-m3。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteModel;
					const nextValue = text.getValue().trim() || DEFAULT_SETTINGS.remoteModel;
					this.plugin.settings.remoteModel = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-model",
						() => {
							this.plugin.settings.remoteModel = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(previousValue);
						return;
					}

					text.setValue(this.plugin.settings.remoteModel);
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
					if (previousValue !== nextValue) {
						this.invalidateIndex(
							"远程模型已变更，现有索引已清空，请重新构建索引。",
						);
					}
				};

				text
					.setPlaceholder(DEFAULT_SETTINGS.remoteModel)
					.setValue(this.plugin.settings.remoteModel);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("超时时间")
			.setDesc("远程请求超时时间（毫秒）。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteTimeoutMs;
					const nextValue = this.parsePositiveIntegerInput(
						text.getValue(),
						DEFAULT_SETTINGS.remoteTimeoutMs,
						1000,
					);
					this.plugin.settings.remoteTimeoutMs = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-timeout-ms",
						() => {
							this.plugin.settings.remoteTimeoutMs = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(String(previousValue));
						return;
					}

					text.setValue(String(this.plugin.settings.remoteTimeoutMs));
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.remoteTimeoutMs));
				text.setValue(String(this.plugin.settings.remoteTimeoutMs));
				text.inputEl.type = "number";
				text.inputEl.min = "1000";
				text.inputEl.step = "1000";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("批大小")
			.setDesc("单次嵌入请求最多发送的文本数量。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.remoteBatchSize;
					const nextValue = this.parsePositiveIntegerInput(
						text.getValue(),
						DEFAULT_SETTINGS.remoteBatchSize,
						1,
					);
					this.plugin.settings.remoteBatchSize = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"remote-batch-size",
						() => {
							this.plugin.settings.remoteBatchSize = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(String(previousValue));
						return;
					}

					text.setValue(String(this.plugin.settings.remoteBatchSize));
					this.plugin.embeddingService.switchProvider(this.plugin.settings);
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.remoteBatchSize));
				text.setValue(String(this.plugin.settings.remoteBatchSize));
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.step = "1";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		const testSetting = new Setting(containerEl)
			.setName("测试连接")
			.setDesc("发送一次真实的嵌入请求，以验证当前远程配置。")
			.addButton((btn) => {
				btn.setButtonText("测试连接").setCta().onClick(async () => {
					btn.setButtonText("测试中...");
					btn.setDisabled(true);

					try {
						await this.plugin.logRuntimeEvent(
							"remote-embedding-test-requested",
							"开始远程嵌入连通性测试。",
							{
								category: "embedding",
								provider: "remote",
								details: [
									`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
									`model=${this.plugin.settings.remoteModel}`,
									`timeout_ms=${this.plugin.settings.remoteTimeoutMs}`,
									`batch_size=${this.plugin.settings.remoteBatchSize}`,
								],
							},
						);

						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						const result = await this.plugin.embeddingService.testConnection();

						testSetting.descEl.querySelector(".sc-api-test-result")?.remove();
						const resultEl = testSetting.descEl.createEl("div", {
							cls: "sc-api-test-result",
						});

						if (result.ok) {
							resultEl.addClass("is-success");
							resultEl.setText(`远程嵌入测试成功，向量维度：${result.dimension}。`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-ok",
								"远程嵌入测试成功。",
								{
									category: "embedding",
									provider: "remote",
									details: [
										`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
										`model=${this.plugin.settings.remoteModel}`,
										`dimension=${result.dimension}`,
									],
								},
							);
						} else {
							resultEl.addClass("is-error");
							resultEl.setText(`远程嵌入测试失败：${result.error}`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-failed",
								`远程嵌入测试失败：${result.error}`,
								{
									level: "warn",
									category: "embedding",
									provider: "remote",
									details: [
										`base_url=${normalizeRemoteBaseUrl(this.plugin.settings.remoteBaseUrl) || "(empty)"}`,
										`model=${this.plugin.settings.remoteModel}`,
									],
								},
							);
							await this.plugin.logRuntimeError(
								"remote-embedding-test",
								result.diagnostic ?? result.error,
								{
									errorType: "runtime",
									filePath: "__settings__/remote-embedding-test",
									provider: "remote",
								},
							);
						}
					} catch (error) {
						testSetting.descEl.querySelector(".sc-api-test-result")?.remove();
						const resultEl = testSetting.descEl.createEl("div", {
							cls: "sc-api-test-result",
						});
						const message = error instanceof Error ? error.message : String(error);
						resultEl.addClass("is-error");
						resultEl.setText(`远程嵌入测试失败：${message}`);
						await this.plugin
							.logRuntimeError("remote-embedding-test", error, {
								errorType: "runtime",
								filePath: "__settings__/remote-embedding-test",
								provider: "remote",
							})
							.catch(() => undefined);
					} finally {
						btn.setButtonText("测试连接");
						btn.setDisabled(false);
					}
				});
			});
	}

	/**
	 * 渲染“关联视图”相关的展示/过滤设置。
	 *
	 * 这些设置不会影响向量本身，但会影响结果的筛选与 UI 展示：
	 * - `maxConnections`：最多展示多少篇相关笔记
	 * - `minSimilarityScore`：相似度阈值（0~1）
	 * - `maxPassagesPerNote`：每篇笔记最多展示多少个“最相关段落”（0 表示不限制）
	 */
	private renderConnectionsSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "关联视图" });

		let thresholdSlider: SliderComponent | null = null;
		let thresholdInput: TextComponent | null = null;

		const syncThresholdControls = (value: number): void => {
			thresholdSlider?.setValue(value);
			thresholdInput?.setValue(String(value));
		};

		const commitThreshold = async (raw: number): Promise<void> => {
			const previousValue = this.plugin.settings.minSimilarityScore;
			const nextValue = Math.max(0, Math.min(1, raw));
			this.plugin.settings.minSimilarityScore = nextValue;

			const saved = await this.saveSettingsOrRollback(
				"min-similarity-score",
				() => {
					this.plugin.settings.minSimilarityScore = previousValue;
				},
				{ refresh: false },
			);

			if (!saved) {
				syncThresholdControls(previousValue);
				return;
			}

			syncThresholdControls(this.plugin.settings.minSimilarityScore);
		};

		new Setting(containerEl)
			.setName("相关度阈值")
			.setDesc(
				"范围 0.0–1.0。阈值越高越严格（更少结果），越低越宽松（更灵敏、更多结果）。无论阈值多高，仍会展示最相关的前 5 条，并将低于阈值的结果标为“弱关联”。",
			)
			.addSlider((slider) => {
				thresholdSlider = slider;
				slider
					.setLimits(0, 1, 0.01)
					.setValue(this.plugin.settings.minSimilarityScore)
					.setInstant(false)
					.onChange((value) => {
						void commitThreshold(value);
					});
			})
			.addText((text) => {
				thresholdInput = text;
				const commit = async (): Promise<void> => {
					const nextValue = this.parseNumberInRangeInput(
						text.getValue(),
						DEFAULT_SETTINGS.minSimilarityScore,
						0,
						1,
					);
					await commitThreshold(nextValue);
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.minSimilarityScore));
				text.setValue(String(this.plugin.settings.minSimilarityScore));
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "1";
				text.inputEl.step = "0.01";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("每篇笔记最多展示段落数")
			.setDesc("0 表示不限制。")
			.addText((text) => {
				const commit = async (): Promise<void> => {
					const previousValue = this.plugin.settings.maxPassagesPerNote;
					const nextValue = this.parsePositiveIntegerInput(
						text.getValue(),
						DEFAULT_SETTINGS.maxPassagesPerNote,
						0,
					);
					this.plugin.settings.maxPassagesPerNote = nextValue;
					const saved = await this.saveSettingsOrRollback(
						"max-passages-per-note",
						() => {
							this.plugin.settings.maxPassagesPerNote = previousValue;
						},
						{ refresh: false },
					);
					if (!saved) {
						text.setValue(String(previousValue));
						return;
					}

					text.setValue(String(this.plugin.settings.maxPassagesPerNote));
				};

				text.setPlaceholder(String(DEFAULT_SETTINGS.maxPassagesPerNote));
				text.setValue(String(this.plugin.settings.maxPassagesPerNote));
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.step = "1";
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});
	}

	/**
	 * 渲染“索引管理” section。
	 *
	 * 这里提供与索引生命周期相关的操作入口：
	 * - 重建索引：调用 `plugin.rebuildIndex()`，并用 `onProgress` 更新进度条
	 * - 存储统计：调用 `plugin.showIndexStorageSummary()` 查看快照文件占用
	 * - 重试失败项：调用 `plugin.retryFailedIndexTasks()` 重试 failed-tasks.json 中记录的任务
	 */
	private renderIndexManagement(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "索引管理" });

		const rebuildSetting = new Setting(containerEl)
			.setName("重建索引")
			.setDesc("")
			.addButton((btn) => {
				const resetButton = (): void => {
					btn.setButtonText(this.plugin.isRebuilding ? "重建中..." : "重建");
					btn.setDisabled(this.plugin.isRebuilding);
				};

				btn.setCta().onClick(async () => {
					btn.setButtonText("重建中...");
					btn.setDisabled(true);
					updateRebuildProgress({
						stage: "preparing",
						message: "正在准备重建索引...",
						percent: 0,
					});

					try {
						await this.plugin.rebuildIndex({ onProgress: updateRebuildProgress });
					} finally {
						updateIndexSummary();
						resetButton();
					}
				});

				resetButton();
			});

		rebuildSetting.addButton((btn) => {
			btn.setButtonText("存储统计").onClick(async () => {
				btn.setDisabled(true);
				try {
					await this.plugin.showIndexStorageSummary();
				} finally {
					btn.setDisabled(false);
				}
			});
		});

		rebuildSetting.descEl.empty();

		const rebuildSummaryEl = rebuildSetting.descEl.createDiv();
		const rebuildStatusEl = rebuildSetting.descEl.createDiv({
			cls: "sc-rebuild-status",
		});
		const rebuildMessageEl = rebuildStatusEl.createDiv();
		const rebuildProgressEl = rebuildStatusEl.createDiv({
			cls: "sc-rebuild-progress",
		});
		const rebuildProgressBarEl = rebuildProgressEl.createDiv({
			cls: "sc-rebuild-progress-bar",
		});
		const rebuildDetailEl = rebuildStatusEl.createDiv({
			cls: "sc-rebuild-detail",
		});

		const clampPercent = (value?: number): number => {
			if (typeof value !== "number" || Number.isNaN(value)) {
				return 0;
			}
			return Math.max(0, Math.min(100, Math.round(value)));
		};

		const updateIndexSummary = (): void => {
			const noteCount = this.plugin.noteStore.size;
			const chunkCount = this.plugin.chunkStore.size;
			const lastFullRebuildAt = this.plugin.settings.lastFullRebuildAt;
			const lastRebuildText =
				lastFullRebuildAt > 0
					? `上次全量重建：${new Date(lastFullRebuildAt).toLocaleString()}`
					: "上次全量重建：未记录";
			const summary =
				noteCount > 0
					? `已索引 ${noteCount} 篇笔记，${chunkCount} 个语义分块。`
					: "当前没有索引数据。";
			rebuildSummaryEl.setText(`${summary}\n${lastRebuildText}`);
		};

		const updateRebuildProgress = (progress: RebuildIndexProgress): void => {
			rebuildStatusEl.style.display = "block";
			rebuildStatusEl.classList.remove("is-success", "is-error");

			if (progress.stage === "success") {
				rebuildStatusEl.classList.add("is-success");
			} else if (progress.stage === "error") {
				rebuildStatusEl.classList.add("is-error");
			}

			rebuildMessageEl.setText(progress.message);
			rebuildProgressBarEl.style.width = `${clampPercent(progress.percent)}%`;

			const details: string[] = [];
			if (typeof progress.done === "number" && typeof progress.total === "number") {
				details.push(`${progress.done}/${progress.total}`);
			}
			if (progress.file) {
				details.push(progress.file);
			}
			if (typeof progress.indexedNotes === "number") {
				details.push(`已索引 ${progress.indexedNotes}`);
			}
			if (typeof progress.failed === "number" && progress.failed > 0) {
				details.push(`失败 ${progress.failed}`);
			}

			if (details.length > 0) {
				rebuildDetailEl.setText(details.join(" | "));
				rebuildDetailEl.style.display = "";
			} else {
				rebuildDetailEl.empty();
				rebuildDetailEl.style.display = "none";
			}
		};

		new Setting(containerEl)
			.setName("重试失败项")
			.setDesc(
				`重试因网络中断或 429 限流导致索引失败的文件（当前：${this.plugin.failedTaskManager.size} 项）。`,
			)
			.addButton((btn) => {
				const resetButton = (): void => {
					btn.setButtonText("重试失败项");
					btn.setDisabled(this.plugin.isRebuilding || this.plugin.failedTaskManager.size === 0);
				};

				btn.setCta().onClick(async () => {
					btn.setButtonText("重试中...");
					btn.setDisabled(true);
					try {
						await this.plugin.retryFailedIndexTasks();
					} finally {
						this.display();
					}
				});

				resetButton();
			});

		updateIndexSummary();
		rebuildStatusEl.style.display = "none";
		rebuildDetailEl.style.display = "none";
	}

	/**
	 * 当某些关键设置变化（例如远程 embeddings 的 baseUrl/model）导致旧索引不再兼容时调用。
	 *
	 * 处理方式很直接：
	 * - 清空内存中的索引数据（store）
	 * - 提示用户需要重建索引
	 */
	private invalidateIndex(message: string): void {
		this.plugin.clearIndexData();
		new Notice(message, 8000);
	}

	/**
	 * 保存 settings；如果保存失败则回滚并（可选）刷新 UI。
	 *
	 * 为什么要回滚？
	 * - Setting 控件通常已经把值写进了 `plugin.settings`
	 * - 如果磁盘写入失败（权限/磁盘问题/异常），就需要把内存态恢复，避免 UI 与真实配置不一致
	 */
	private async saveSettingsOrRollback(
		context: string,
		rollback: () => void,
		options: {
			failureMessage?: string;
			refresh?: boolean;
		} = {},
	): Promise<boolean> {
		try {
			await this.plugin.saveSettings(context);
			return true;
		} catch {
			rollback();
			new Notice(options.failureMessage ?? "保存设置失败，请检查错误日志。", 6000);
			if (options.refresh ?? true) {
				this.display();
			}
			return false;
		}
	}

	/**
	 * 解析一个正整数输入。
	 *
	 * - 非法/小于 minimum：返回 fallback
	 * - 合法：返回解析后的整数
	 */
	private parsePositiveIntegerInput(
		value: string,
		fallback: number,
		minimum: number = 1,
	): number {
		const parsed = Number.parseInt(value.trim(), 10);
		if (!Number.isInteger(parsed) || parsed < minimum) {
			return fallback;
		}
		return parsed;
	}

	/**
	 * 解析一个范围内的小数输入（例如 0~1 的相似度阈值）。
	 * - 非法/越界：返回 fallback
	 * - 合法：返回解析后的 number
	 */
	private parseNumberInRangeInput(
		value: string,
		fallback: number,
		minimum: number,
		maximum: number,
	): number {
		const parsed = Number.parseFloat(value.trim());
		if (!Number.isFinite(parsed)) {
			return fallback;
		}
		if (parsed < minimum || parsed > maximum) {
			return fallback;
		}
		return parsed;
	}
}

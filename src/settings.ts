/**
 * Plugin settings UI.
 */

import { App, Notice, PluginSettingTab, Setting, SliderComponent, TextComponent } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import {
	DEFAULT_SETTINGS,
	type RebuildIndexProgress,
} from "./types";
import { normalizeRemoteBaseUrl } from "./embeddings/remote-provider";

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

	constructor(app: App, plugin: SemanticConnectionsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "语义关联设置" });
		this.renderRemoteSettings(containerEl);

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

		this.renderBehaviorSettings(containerEl);
		this.renderConnectionsSettings(containerEl);
		this.renderIndexManagement(containerEl);
	}

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
			.setName("自动增量索引")
			.setDesc(
				"开启后会监听笔记新增/修改/删除/重命名，并自动对变更文件触发增量 Embedding（仅重新索引受影响的笔记，不会全量重建）。删除/重命名会立即处理；新增/修改在停止编辑约 1 秒后自动入队。",
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
							? "已开启自动增量索引：文件变更将自动触发增量 Embedding。"
							: "已关闭自动增量索引：文件变更不会自动处理，可手动执行\u201c同步变动笔记\u201d。",
						6000,
				);
			}),
		);
	}

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

	private invalidateIndex(message: string): void {
		this.plugin.clearIndexData();
		new Notice(message, 8000);
	}

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

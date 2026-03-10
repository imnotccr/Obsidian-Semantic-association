/**
 * Plugin settings UI.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SemanticConnectionsPlugin from "./main";
import {
	DEFAULT_SETTINGS,
	type IndexErrorEntry,
	type RebuildIndexProgress,
	type RuntimeLogEntry,
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

		new Setting(containerEl)
			.setName("最大关联数")
			.setDesc("侧栏中显示的最大相关笔记数量。")
			.addSlider((slider) =>
				slider
					.setLimits(5, 50, 5)
					.setValue(this.plugin.settings.maxConnections)
					.setDynamicTooltip()
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.maxConnections;
						this.plugin.settings.maxConnections = value;
						await this.saveSettingsOrRollback("max-connections", () => {
							this.plugin.settings.maxConnections = previousValue;
						});
					}),
			);

		new Setting(containerEl)
			.setName("自动索引")
			.setDesc("Markdown 文件变化时自动更新索引。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoIndex).onChange(async (value) => {
					const previousValue = this.plugin.settings.autoIndex;
					this.plugin.settings.autoIndex = value;
					await this.saveSettingsOrRollback("auto-index", () => {
						this.plugin.settings.autoIndex = previousValue;
					});
				}),
			);

		new Setting(containerEl)
			.setName("启动时自动打开关联视图")
			.setDesc("插件启动时自动打开右侧关联视图。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenConnectionsView)
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.autoOpenConnectionsView;
						this.plugin.settings.autoOpenConnectionsView = value;
						await this.saveSettingsOrRollback("auto-open-connections-view", () => {
							this.plugin.settings.autoOpenConnectionsView = previousValue;
						});
					}),
			);

		new Setting(containerEl)
			.setName("向量提供方式")
			.setDesc("选择生成 embeddings 的方式。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("remote", "远程 API")
					.addOption("mock", "Mock")
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						const previousValue = this.plugin.settings.embeddingProvider;
						const nextValue = value as "remote" | "mock";
						this.plugin.settings.embeddingProvider = nextValue;
						const saved = await this.saveSettingsOrRollback("embedding-provider", () => {
							this.plugin.settings.embeddingProvider = previousValue;
						});
						if (!saved) {
							return;
						}

						this.plugin.embeddingService.switchProvider(this.plugin.settings);
						if (previousValue !== nextValue) {
							this.invalidateIndex("向量提供方式已变更，旧索引已清空，请重新执行“重建索引”。");
						}

						this.display();
					}),
			);

		if (this.plugin.settings.embeddingProvider === "remote") {
			this.renderRemoteSettings(containerEl);
		}

		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("索引时需要跳过的文件夹，每行一个路径。")
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
							new Notice("排除文件夹已更新。如需应用到现有索引，请重新执行“重建索引”。", 6000);
						}
					}),
			);

		this.renderIndexManagement(containerEl);
		this.renderLogSection(containerEl);
	}

	private renderRemoteSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "远程 Embeddings" });

		new Setting(containerEl)
			.setName("API Base URL")
			.setDesc("插件会请求 {baseUrl}/v1/embeddings。")
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
						this.invalidateIndex("远程 API Base URL 已变更，旧索引已清空，请重新执行“重建索引”。");
					}
				};

				text.setPlaceholder("https://your-api.example.com").setValue(
					this.plugin.settings.remoteBaseUrl,
				);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("请求远程 embeddings API 的 Bearer Token。")
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
			.setName("Remote Model")
			.setDesc("默认使用 BAAI/bge-m3，仅接入 dense embedding，实际维度以接口返回为准。")
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
						this.invalidateIndex("远程模型已变更，旧索引已清空，请重新执行“重建索引”。");
					}
				};

				text.setPlaceholder(DEFAULT_SETTINGS.remoteModel).setValue(
					this.plugin.settings.remoteModel,
				);
				text.inputEl.addEventListener("change", () => {
					void commit();
				});
			});

		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("远程 embeddings 请求超时时间，单位毫秒。")
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
			.setName("Batch Size")
			.setDesc("批量 embedding 时每次请求携带的文本条数。")
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
			.setName("Test Connection")
			.setDesc("真正发送一次 embeddings 请求，验证 Base URL、API Key 和 Model 是否可用。")
			.addButton((btn) => {
				btn.setButtonText("Test Connection").setCta().onClick(async () => {
					btn.setButtonText("Testing...");
					btn.setDisabled(true);

					try {
						await this.plugin.logRuntimeEvent(
							"remote-embedding-test-requested",
							"开始测试远程 embeddings 接口。",
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
							resultEl.setText(`远程 embeddings 测试成功，维度 ${result.dimension}。`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-ok",
								"远程 embeddings 接口测试成功。",
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
							resultEl.setText(`远程 embeddings 测试失败：${result.error}`);
							await this.plugin.logRuntimeEvent(
								"remote-embedding-test-failed",
								`远程 embeddings 接口测试失败：${result.error}`,
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
						resultEl.setText(`远程 embeddings 测试失败：${message}`);
						await this.plugin
							.logRuntimeError("remote-embedding-test", error, {
								errorType: "runtime",
								filePath: "__settings__/remote-embedding-test",
								provider: "remote",
							})
							.catch(() => undefined);
					} finally {
						btn.setButtonText("Test Connection");
						btn.setDisabled(false);
					}
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
		const rebuildErrorHintEl = rebuildSetting.descEl.createDiv({
			cls: "sc-setting-error-hint",
		});
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
			rebuildSummaryEl.setText(
				noteCount > 0
					? `当前索引：${noteCount} 篇笔记，${chunkCount} 个语义块`
					: "暂无索引数据",
			);

			const errorCount = this.plugin.errorLogger.size;
			if (errorCount > 0) {
				rebuildErrorHintEl.setText(`错误日志条目：${errorCount}`);
				rebuildErrorHintEl.style.display = "";
				return;
			}

			rebuildErrorHintEl.empty();
			rebuildErrorHintEl.style.display = "none";
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
				details.push(`已索引 ${progress.indexedNotes} 篇笔记`);
			}
			if (typeof progress.failed === "number" && progress.failed > 0) {
				details.push(`失败 ${progress.failed} 篇`);
			}

			if (details.length > 0) {
				rebuildDetailEl.setText(details.join(" · "));
				rebuildDetailEl.style.display = "";
			} else {
				rebuildDetailEl.empty();
				rebuildDetailEl.style.display = "none";
			}
		};

		updateIndexSummary();
		rebuildStatusEl.style.display = "none";
		rebuildDetailEl.style.display = "none";
	}

	private renderLogSection(containerEl: HTMLElement): void {
		containerEl.createEl("h2", { text: "日志" });

		const runtimeSetting = new Setting(containerEl)
			.setName("运行日志")
			.setDesc("显示最近 30 条运行日志。")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderRuntimeLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearRuntimeLogs();
						renderRuntimeLog();
					} catch {
						new Notice("清空运行日志失败，请查看错误日志。", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		const runtimeLogOutputEl = runtimeSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const errorSetting = new Setting(containerEl)
			.setName("错误日志")
			.setDesc("显示最近 20 条错误日志。")
			.addButton((btn) => {
				btn.setButtonText("刷新").onClick(() => {
					renderErrorLog();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("清空").onClick(async () => {
					btn.setDisabled(true);
					try {
						await this.plugin.clearErrorLogs();
						renderErrorLog();
					} catch {
						new Notice("清空错误日志失败，请查看运行日志。", 6000);
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		const errorLogOutputEl = errorSetting.descEl.createEl("pre", {
			cls: "sc-log-output",
		});

		const renderRuntimeLog = (): void => {
			runtimeLogOutputEl.setText(
				this.formatRuntimeLogEntries(this.plugin.getRecentRuntimeLogs(30)),
			);
		};

		const renderErrorLog = (): void => {
			errorLogOutputEl.setText(
				this.formatErrorLogEntries(this.plugin.errorLogger.getRecent(20)),
			);
		};

		renderRuntimeLog();
		renderErrorLog();
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
			new Notice(options.failureMessage ?? "设置保存失败，请查看错误日志。", 6000);
			if (options.refresh ?? true) {
				this.display();
			}
			return false;
		}
	}

	private formatRuntimeLogEntries(entries: RuntimeLogEntry[]): string {
		if (entries.length === 0) {
			return "暂无运行日志。";
		}

		return entries
			.map((entry) => {
				const header = `[${this.formatLogTimestamp(entry.timestamp)}] ${entry.level.toUpperCase()} ${entry.event}`;
				const lines = [header, `  ${entry.message}`];
				const meta = [entry.category, entry.provider].filter((item): item is string => Boolean(item));
				if (meta.length > 0) {
					lines.push(`  ${meta.join(" · ")}`);
				}
				if (entry.details && entry.details.length > 0) {
					lines.push(...entry.details.map((detail) => `  - ${detail}`));
				}
				return lines.join("\n");
			})
			.join("\n\n");
	}

	private formatErrorLogEntries(entries: IndexErrorEntry[]): string {
		if (entries.length === 0) {
			return "暂无错误日志。";
		}

		return entries
			.map((entry) => {
				const header = `[${this.formatLogTimestamp(entry.timestamp)}] ${entry.errorType} ${entry.filePath}`;
				const lines = [header, `  ${entry.message}`];
				const meta = [
					entry.provider ? `provider=${entry.provider}` : undefined,
					entry.stage ? `stage=${entry.stage}` : undefined,
				].filter((item): item is string => Boolean(item));
				if (meta.length > 0) {
					lines.push(`  ${meta.join(" · ")}`);
				}
				if (entry.details && entry.details.length > 0) {
					lines.push(...entry.details.map((detail) => `  - ${detail}`));
				}
				return lines.join("\n");
			})
			.join("\n\n");
	}

	private formatLogTimestamp(timestamp: number): string {
		return new Date(timestamp).toLocaleString("zh-CN", {
			hour12: false,
		});
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
}

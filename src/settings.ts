/**
 * 插件设置页
 *
 * 提供用户可配置项：
 * - 最大关联数
 * - 排除文件夹
 * - Embedding Provider 选择
 * - 自动索引开关
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type SemanticConnectionsPlugin from "./main";

export class SettingTab extends PluginSettingTab {
	private plugin: SemanticConnectionsPlugin;

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
					.addOption("remote", "远程 API（OpenAI 兼容）")
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						this.plugin.settings.embeddingProvider = value as "mock" | "local" | "remote";
						await this.plugin.saveSettings();
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
						})
				);

			new Setting(containerEl)
				.setName("模型名称")
				.setDesc("Embedding 模型 ID")
				.addText((text) =>
					text
						.setPlaceholder("text-embedding-3-small")
						.setValue(this.plugin.settings.remoteModel)
						.onChange(async (value) => {
							this.plugin.settings.remoteModel = value.trim();
							await this.plugin.saveSettings();
						})
				);

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
						})
				);
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
					})
			);
	}
}

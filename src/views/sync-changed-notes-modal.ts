/**
 * SyncChangedNotesModal - “同步变动笔记”确认弹窗。
 *
 * 触发位置：main.ts 的 `syncChangedNotes()`。
 *
 * 弹窗内容：
 * - 变动笔记数量
 * - 预计 token 消耗（粗略估算）
 *
 * 交互：
 * - 取消：直接关闭
 * - 确认：关闭弹窗并调用 onConfirm（开始实际同步，会调用 embeddings API）
 */
import { App, Modal } from "obsidian";

/** 一个轻量 Modal：只做展示与确认，不包含业务逻辑。 */
export class SyncChangedNotesModal extends Modal {
	constructor(
		app: App,
		private options: {
			changedCount: number;
			tokenEstimate: number;
			onConfirm: () => Promise<void> | void;
		},
	) {
		super(app);
	}

	/** Modal 打开时渲染内容与按钮。 */
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "同步变动笔记" });

		const tokenText = Number.isFinite(this.options.tokenEstimate)
			? this.options.tokenEstimate.toLocaleString()
			: "未知";
		contentEl.createEl("p", {
			text: `发现 ${this.options.changedCount} 篇笔记有变动，预计消耗约 ${tokenText} Token，是否开始同步？`,
		});

		const buttons = contentEl.createEl("div", { cls: "sc-modal-buttons" });

		const cancelBtn = buttons.createEl("button", { text: "取消" });
		cancelBtn.addClass("mod-muted");
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = buttons.createEl("button", { text: "开始同步" });
		confirmBtn.addClass("mod-cta");
		confirmBtn.addEventListener("click", () => {
			confirmBtn.disabled = true;
			this.close();
			void this.options.onConfirm();
		});
	}
}

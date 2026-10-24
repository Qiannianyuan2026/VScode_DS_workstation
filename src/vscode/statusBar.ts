import * as vscode from 'vscode';
import type { WorkbenchState } from '../core/protocol';

export class StatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'deepseek.openWorkbench';
        this.item.text = '$(zap) DeepSeek';
        this.item.tooltip = '打开 DeepSeek 工作台';
        this.item.show();
    }

    update(state: WorkbenchState): void {
        if (!state.hasKey) {
            this.item.text = '$(zap) DeepSeek（未配置）';
            this.item.tooltip = '还没有配置 DeepSeek API Key，点击打开工作台';
            this.item.backgroundColor = undefined;
            return;
        }
        if (state.busy) {
            this.item.text = '$(sync~spin) DeepSeek';
            this.item.tooltip = 'DeepSeek 正在生成…';
            return;
        }
        const short = state.model.includes('pro') ? 'V4 Pro' : state.model.includes('flash') ? 'V4.1 Flash' : state.model;
        this.item.text = `$(zap) DeepSeek · ${short}`;
        this.item.tooltip = '打开 DeepSeek 工作台（侧边栏对话 / 定点修改）';
        this.item.backgroundColor = undefined;
    }

    dispose(): void {
        this.item.dispose();
    }
}

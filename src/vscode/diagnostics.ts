import * as vscode from 'vscode';
import { ApiError, DeepSeekClient } from '../core/client';
import type { ApiKeyStore } from './apiKey';
import type { WorkbenchSettings } from './settings';

/**
 * 「检查 API 配置与连通性」：把 Key 是否配置、地址是否合法、网络是否可达
 * 分开告诉用户，而不是笼统地报「网络请求失败」。
 */
export async function checkSetup(
    keys: ApiKeyStore,
    settings: WorkbenchSettings,
    output: vscode.OutputChannel
): Promise<void> {
    const apiKey = await keys.get();
    if (!apiKey) {
        const action = await vscode.window.showWarningMessage('还没有配置 DeepSeek API Key。', '现在设置');
        if (action) {
            await vscode.commands.executeCommand('deepseek.setApiKey');
        }
        return;
    }

    let client: DeepSeekClient;
    try {
        client = new DeepSeekClient({
            apiKey,
            baseUrl: settings.baseUrl,
            timeoutMs: settings.timeoutMs,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[check] ${message}`);
        const action = await vscode.window.showErrorMessage(`DeepSeek 配置检查失败：${message}`, '打开设置');
        if (action) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek');
        }
        return;
    }

    try {
        const models = await client.listModels();
        const available = models.length > 0 ? models.join('、') : '（未返回模型列表）';
        void vscode.window.showInformationMessage(
            `DeepSeek 连接正常：${settings.baseUrl}，可用模型 ${available}。`
        );
        output.appendLine(`[check] 连接正常 ${settings.baseUrl} models=${available}`);
    } catch (error) {
        if (error instanceof ApiError && error.kind === 'auth') {
            const action = await vscode.window.showErrorMessage('API Key 无效，请重新设置。', '重新设置');
            if (action) {
                await vscode.commands.executeCommand('deepseek.setApiKey');
            }
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const action = await vscode.window.showErrorMessage(
            `DeepSeek 连接失败：${message}`,
            '打开设置',
            '打开日志'
        );
        if (action === '打开设置') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek');
        } else if (action === '打开日志') {
            output.show();
        }
        output.appendLine(`[check] 失败：${message}`);
    }
}

import * as vscode from 'vscode';

const SECRET_KEY = 'deepseek.apiKey';

/** API Key 只存在 VS Code 的加密存储里，不落盘到任何配置文件。 */
export class ApiKeyStore implements vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    private readonly listener: vscode.Disposable;

    readonly onDidChange = this.changeEmitter.event;

    constructor(private readonly secrets: vscode.SecretStorage) {
        this.listener = secrets.onDidChange((event) => {
            if (event.key === SECRET_KEY) {
                this.changeEmitter.fire();
            }
        });
    }

    async get(): Promise<string | undefined> {
        const value = await this.secrets.get(SECRET_KEY);
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
    }

    async has(): Promise<boolean> {
        return Boolean(await this.get());
    }

    /** 弹输入框让用户粘贴 Key；返回是否成功保存。 */
    async prompt(): Promise<boolean> {
        const existing = await this.secrets.get(SECRET_KEY);
        const value = await vscode.window.showInputBox({
            title: 'DeepSeek API Key',
            prompt: '在 platform.deepseek.com 创建 API Key 后粘贴到这里（只保存在本机加密存储中）',
            placeHolder: 'sk-...',
            password: true,
            ignoreFocusOut: true,
            value: existing ? '' : '',
            validateInput: (input) => {
                const trimmed = input.trim();
                if (!trimmed) {
                    return undefined;
                }
                if (trimmed.length < 8) {
                    return 'Key 看起来太短了，请检查是否粘贴完整。';
                }
                return undefined;
            },
        });

        if (!value || !value.trim()) {
            return false;
        }
        await this.secrets.store(SECRET_KEY, value.trim());
        this.changeEmitter.fire();
        void vscode.window.showInformationMessage('DeepSeek API Key 已保存（仅存于本机加密存储）。');
        return true;
    }

    async clear(): Promise<void> {
        await this.secrets.delete(SECRET_KEY);
        this.changeEmitter.fire();
        void vscode.window.showInformationMessage('已清除 DeepSeek API Key。');
    }

    dispose(): void {
        this.listener.dispose();
        this.changeEmitter.dispose();
    }
}

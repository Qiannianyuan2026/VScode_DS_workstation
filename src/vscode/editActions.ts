import * as vscode from 'vscode';
import { alignIndent, detectEol, matchesApplied } from '../core/edit';
import type { EditTarget } from '../core/types';
import { UserFacingError } from './errors';

async function openDocument(uri: string): Promise<vscode.TextDocument> {
    try {
        return await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
    } catch {
        throw new UserFacingError('找不到目标文件，可能已被移动或删除。');
    }
}

/**
 * 把定点修改写进文件。写入前校验文档版本，避免把预览套到已经变过的文件上。
 * 返回更新过版本号的 target，供后续撤销使用。
 */
export async function applyEditTarget(target: EditTarget): Promise<EditTarget> {
    const document = await openDocument(target.uri);

    if (document.version !== target.documentVersion) {
        throw new UserFacingError('文件在生成过程中被修改了，这次预览已过期，请重新生成。');
    }

    const start = document.positionAt(target.startOffset);
    const end = document.positionAt(target.endOffset);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(start, end), target.newText);

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        throw new UserFacingError('写入文件失败，请检查文件是否只读。');
    }

    return { ...target, documentVersion: document.version };
}

/** 撤销一次定点修改；内容与预期不一致时拒绝，避免误伤用户的新改动。 */
export async function revertEditTarget(target: EditTarget): Promise<void> {
    const document = await openDocument(target.uri);
    const text = document.getText();

    if (!matchesApplied(text, target.startOffset, target.newText)) {
        throw new UserFacingError('文件内容已经被其它操作改动，无法安全撤销这次修改。');
    }

    const start = document.positionAt(target.startOffset);
    const end = document.positionAt(target.startOffset + target.newText.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(start, end), target.originalText);

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        throw new UserFacingError('撤销失败，请检查文件是否只读。');
    }
}

/** 在光标处插入一段代码，自动沿用当前行缩进。 */
export async function insertCodeAtCursor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new UserFacingError('没有打开的编辑器，无法插入代码。');
    }

    const document = editor.document;
    const position = editor.selection.active;
    const currentLine = document.lineAt(position.line);
    const indent = /^[ \t]*/.exec(currentLine.text)?.[0] ?? '';
    const eol = detectEol(document.getText());

    const lines = code.replace(/\r\n/g, '\n').split('\n');
    let snippet = lines.join(eol);
    if (currentLine.text.trim().length > 0) {
        snippet = eol + lines.map((line, index) => (index === 0 ? indent + line : line)).join(eol);
    }

    const ok = await editor.edit((builder) => builder.insert(position, snippet));
    if (!ok) {
        throw new UserFacingError('插入失败。');
    }
}

/** 用聊天里的代码替换当前选区；没有选区就退化为在光标处插入。 */
export async function replaceSelectionFromChat(code: string): Promise<'replaced' | 'inserted'> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        throw new UserFacingError('没有打开的编辑器，无法替换代码。');
    }
    if (editor.selection.isEmpty) {
        await insertCodeAtCursor(code);
        return 'inserted';
    }

    const document = editor.document;
    const selected = document.getText(editor.selection);
    const eol = detectEol(document.getText());
    const aligned = alignIndent(selected, code, eol);

    const ok = await editor.edit((builder) => builder.replace(editor.selection, aligned));
    if (!ok) {
        throw new UserFacingError('替换失败。');
    }
    return 'replaced';
}

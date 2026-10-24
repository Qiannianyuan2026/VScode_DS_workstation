import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectEol } from '../core/edit';
import type { ContextInfo } from '../core/protocol';
import { numberLines, renderEditorContext, truncateMiddle } from '../core/prompt';
import type { ContextSnapshot } from '../core/types';
import { UserFacingError } from './errors';
import type { WorkbenchSettings } from './settings';

export interface CaptureOptions {
    /** 定点修改必须有选区。 */
    needSelection: boolean;
    includeSelection: boolean;
    includeFile: boolean;
}

/** 负责把编辑器现状整理成模型可用的上下文与定点修改目标。 */
export class ContextGatherer {
    constructor(private readonly getSettings: () => WorkbenchSettings) {}

    /** 侧边栏状态条用的轻量描述。 */
    describe(): ContextInfo | null {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return null;
        }
        const document = editor.document;
        const info: ContextInfo = {
            fileName: path.basename(document.fileName),
            languageId: document.languageId,
            lineCount: document.lineCount,
        };
        const selection = editor.selection;
        if (!selection.isEmpty) {
            info.selection = {
                startLine: selection.start.line + 1,
                endLine: selection.end.line + 1,
                text: document.getText(selection),
            };
        }
        return info;
    }

    async capture(options: CaptureOptions): Promise<ContextSnapshot | undefined> {
        const editor = vscode.window.activeTextEditor;
        const settings = this.getSettings();

        if (!editor) {
            if (options.needSelection) {
                throw new UserFacingError('请先打开一个文件并选中要修改的代码。');
            }
            return undefined;
        }

        const document = editor.document;
        const fullText = document.getText();
        const eol = detectEol(fullText);
        const fileName = path.basename(document.fileName);
        const inWorkspace = Boolean(vscode.workspace.getWorkspaceFolder(document.uri));
        const relativePath = inWorkspace ? vscode.workspace.asRelativePath(document.uri, false) : undefined;

        const hasSelection = !editor.selection.isEmpty;
        if (options.needSelection && !hasSelection) {
            throw new UserFacingError('定点修改需要先在编辑器里选中一段代码。');
        }

        const targetRange = hasSelection
            ? new vscode.Range(editor.selection.start, editor.selection.end)
            : this.cursorWindow(document, settings.contextLines);

        const selectedText = document.getText(targetRange);
        const startLine = targetRange.start.line + 1;
        const endLine = targetRange.end.line + 1;

        let beforeContext: string | undefined;
        let afterContext: string | undefined;
        if (settings.contextLines > 0 && (options.includeSelection || options.includeFile)) {
            const beforeStart = Math.max(0, targetRange.start.line - settings.contextLines);
            if (beforeStart < targetRange.start.line) {
                const text = document.getText(new vscode.Range(beforeStart, 0, targetRange.start.line, 0));
                beforeContext = numberLines(text.replace(/\n$/, ''), beforeStart + 1);
            }
            const afterEnd = Math.min(document.lineCount - 1, targetRange.end.line + 1 + settings.contextLines);
            if (afterEnd > targetRange.end.line) {
                const text = document.getText(new vscode.Range(targetRange.end.line + 1, 0, afterEnd, 0));
                afterContext = numberLines(text.replace(/\n$/, ''), targetRange.end.line + 2);
            }
        }

        const fullFileText = options.includeFile ? truncateMiddle(fullText, settings.maxFileChars) : undefined;

        let contextText: string;
        if (options.includeSelection) {
            contextText = renderEditorContext({
                fileName,
                relativePath,
                languageId: document.languageId,
                startLine,
                endLine,
                selectedText,
                beforeContext,
                afterContext,
                fullFileText,
                cursorLine: editor.selection.active.line + 1,
            });
        } else {
            contextText = [
                '## 当前编辑器上下文',
                `文件：${fileName}${relativePath && relativePath !== fileName ? `（工作区相对路径：${relativePath}）` : ''}`,
                `语言：${document.languageId}`,
                `光标行：${editor.selection.active.line + 1}`,
            ].join('\n');
        }

        const snapshot: ContextSnapshot = {
            text: contextText,
            label: hasSelection ? `${fileName}:${startLine}-${endLine}` : `${fileName}:${startLine}`,
        };

        if (hasSelection) {
            snapshot.editor = {
                uri: document.uri.toString(),
                fileName,
                languageId: document.languageId,
                documentVersion: document.version,
                selection: {
                    startLine,
                    endLine,
                    startCharacter: editor.selection.start.character,
                    endCharacter: editor.selection.end.character,
                },
                fullText,
                eol,
                startOffset: document.offsetAt(targetRange.start),
                endOffset: document.offsetAt(targetRange.end),
            };
        }

        return snapshot;
    }

    /** 没有选区时，把光标上下若干行当成阅读上下文。 */
    private cursorWindow(document: vscode.TextDocument, contextLines: number): vscode.Range {
        const cursorLine = vscode.window.activeTextEditor?.selection.active.line ?? 0;
        const start = Math.max(0, cursorLine - contextLines);
        const end = Math.min(document.lineCount - 1, cursorLine + contextLines);
        return new vscode.Range(start, 0, end, document.lineAt(end).text.length);
    }
}

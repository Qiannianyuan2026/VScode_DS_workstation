import * as vscode from 'vscode';
import { DEFAULT_MODEL, normalizeModel } from '../core/models';
import type { Currency } from '../core/pricing';

export interface WorkbenchSettings {
    model: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
    contextLines: number;
    maxFileChars: number;
    maxHistoryTurns: number;
    timeoutMs: number;
    confirmBeforeApply: boolean;
    extraSystemPrompt: string;
    extraModels: string[];
    thinking: boolean;
    reasoningEffort: 'low' | 'high' | 'max';
    keepFocusAfterFileSwitch: boolean;
    currency: Currency;
    usdToCny: number;
}

export function readSettings(): WorkbenchSettings {
    const config = vscode.workspace.getConfiguration('deepseek');
    return {
        model: normalizeModel(config.get<string>('model', DEFAULT_MODEL)),
        baseUrl: config.get<string>('apiBaseUrl', 'https://api.deepseek.com'),
        temperature: config.get<number>('temperature', 0.2),
        maxTokens: config.get<number>('maxTokens', 8192),
        contextLines: config.get<number>('contextLines', 30),
        maxFileChars: config.get<number>('maxFileChars', 60000),
        maxHistoryTurns: config.get<number>('maxHistoryTurns', 8),
        timeoutMs: config.get<number>('requestTimeoutMs', 120000),
        confirmBeforeApply: config.get<boolean>('confirmBeforeApply', true),
        extraSystemPrompt: config.get<string>('extraSystemPrompt', ''),
        extraModels: config.get<string[]>('extraModels', []),
        thinking: config.get<boolean>('thinking', true),
        reasoningEffort: config.get<'low' | 'high' | 'max'>('reasoningEffort', 'high'),
        keepFocusAfterFileSwitch: config.get<boolean>('keepFocusAfterFileSwitch', true),
        currency: config.get<Currency>('currency', 'CNY'),
        usdToCny: config.get<number>('usdToCny', 7.2),
    };
}

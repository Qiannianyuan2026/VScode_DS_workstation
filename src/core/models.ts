/** 模型识别的小工具：V4 系列、旧别名、思考模式能力。 */

export const DEFAULT_MODEL = 'deepseek-flash';

/** 拉取失败时的兜底列表（顺序即下拉框顺序）。 */
export const FALLBACK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

/** V3 / R1 时代的模型名，已从本扩展移除，不再出现在下拉框与兜底列表里。 */
const LEGACY_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);

const LABELS: Record<string, string> = {
    'deepseek-flash': 'V4.1 Flash',
    'deepseek-v4-flash': 'V4 Flash（旧名）',
    'deepseek-v4-flash-vision-exp': 'V4 Flash Vision（旧名）',
    'deepseek-v4': 'V4（旧名）',
    'deepseek-v4-pro': 'V4 Pro',
};

export function isLegacyModel(id: string): boolean {
    return LEGACY_MODELS.has((id ?? '').trim().toLowerCase());
}

/** 旧模型名统一回落到默认模型，避免历史配置继续触发请求。 */
export function normalizeModel(id: string | undefined): string {
    const trimmed = (id ?? '').trim();
    if (!trimmed || isLegacyModel(trimmed)) {
        return DEFAULT_MODEL;
    }
    return trimmed;
}

export function modelLabel(id: string): string {
    return LABELS[id] ?? id;
}

/** 是否支持用 `thinking.type` 开关思考模式（V4 / Flash 系列）。 */
export function supportsThinkingToggle(id: string): boolean {
    const model = id.toLowerCase();
    return model.includes('flash') || /(?:^|[-_.])v4(?:[-_.]|$)/.test(model);
}

export function isValidModelId(id: string): boolean {
    const trimmed = id.trim();
    return trimmed.length > 0 && trimmed.length <= 120 && !/\s/.test(trimmed);
}

/** API 返回的模型优先，其次兜底列表，最后是用户手填的额外模型；去掉旧模型并去重。 */
export function mergeModels(discovered: string[], extras: string[] = []): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of [...discovered, ...FALLBACK_MODELS, ...extras]) {
        const trimmed = id?.trim();
        if (!trimmed || seen.has(trimmed) || isLegacyModel(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_MODEL,
    FALLBACK_MODELS,
    mergeModels,
    modelLabel,
    normalizeModel,
    supportsThinkingToggle,
    isLegacyModel,
    isValidModelId,
} = require('../dist/core/models.js');

test('只保留 V4 系列，V3 / R1 已移除', () => {
    assert.deepEqual(FALLBACK_MODELS, ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(DEFAULT_MODEL, 'deepseek-flash');
    assert.equal(modelLabel('deepseek-flash'), 'V4.1 Flash');
    assert.equal(modelLabel('deepseek-v4-pro'), 'V4 Pro');
    assert.equal(modelLabel('deepseek-v4-flash'), 'V4 Flash（旧名）');
    assert.equal(modelLabel('deepseek-chat'), 'deepseek-chat');
    assert.equal(modelLabel('deepseek-reasoner'), 'deepseek-reasoner');
});

test('旧模型会被识别并迁移到默认模型', () => {
    assert.equal(isLegacyModel('deepseek-chat'), true);
    assert.equal(isLegacyModel(' deepseek-reasoner '), true);
    assert.equal(isLegacyModel('deepseek-v4-pro'), false);
    assert.equal(normalizeModel('deepseek-chat'), 'deepseek-flash');
    assert.equal(normalizeModel('deepseek-reasoner'), 'deepseek-flash');
    assert.equal(normalizeModel(''), 'deepseek-flash');
    assert.equal(normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro');
    assert.equal(normalizeModel('my-gateway-model'), 'my-gateway-model');
});

test('思考模式开关能力判定', () => {
    assert.equal(supportsThinkingToggle('deepseek-flash'), true);
    assert.equal(supportsThinkingToggle('deepseek-v4-pro'), true);
    assert.equal(supportsThinkingToggle('deepseek-v4'), true);
    assert.equal(supportsThinkingToggle('deepseek-v4-flash'), true);
    assert.equal(supportsThinkingToggle('deepseek-chat'), false);
    assert.equal(supportsThinkingToggle('deepseek-reasoner'), false);
});

test('模型合并：过滤旧模型、API 优先、兜底补齐、去重', () => {
    const merged = mergeModels(
        ['deepseek-chat', 'deepseek-v4-pro', 'deepseek-flash', 'deepseek-reasoner'],
        ['my-gateway', 'deepseek-chat']
    );
    assert.deepEqual(merged, ['deepseek-v4-pro', 'deepseek-flash', 'my-gateway']);
    assert.deepEqual(mergeModels([]), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.deepEqual(mergeModels(['  '], ['  ']), ['deepseek-flash', 'deepseek-v4-pro']);
});

test('模型 id 校验拦住空白与空格', () => {
    assert.equal(isValidModelId('deepseek-flash'), true);
    assert.equal(isValidModelId('  deepseek-flash  '), true);
    assert.equal(isValidModelId(''), false);
    assert.equal(isValidModelId('bad model'), false);
    assert.equal(isValidModelId('x'.repeat(121)), false);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeCost, isPeakTime, formatMoney, formatCostTooltip } = require('../dist/core/pricing.js');

const usage = (prompt, completion, extra = {}) => ({
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    ...extra,
});

test('峰时判定：工作日 UTC 01-04、06-10，其余与周末为谷时', () => {
    const wednesday = (hour, minute = 0) => new Date(Date.UTC(2026, 9, 21, hour, minute));
    assert.equal(wednesday(2).getUTCDay(), 3, '测试假定的星期三');
    assert.equal(isPeakTime(wednesday(1, 0)), true);
    assert.equal(isPeakTime(wednesday(0, 59)), false);
    assert.equal(isPeakTime(wednesday(3, 59)), true);
    assert.equal(isPeakTime(wednesday(4, 0)), false);
    assert.equal(isPeakTime(wednesday(6, 0)), true);
    assert.equal(isPeakTime(wednesday(9, 59)), true);
    assert.equal(isPeakTime(wednesday(10, 0)), false);
    assert.equal(isPeakTime(wednesday(5, 0)), false);

    const saturday = new Date(Date.UTC(2026, 9, 24, 2, 0));
    assert.equal(saturday.getUTCDay(), 6);
    assert.equal(isPeakTime(saturday), false);
});

test('Flash 谷时价：1M 输入未命中 + 1M 输出 = $0.75', () => {
    const offPeak = new Date(Date.UTC(2026, 9, 21, 12, 0));
    const cost = computeCost('deepseek-flash', usage(1_000_000, 1_000_000), offPeak);
    assert.ok(cost);
    assert.equal(cost.peak, false);
    assert.ok(Math.abs(cost.usd - 0.75) < 1e-9);
});

test('Flash 峰时价是谷时的两倍', () => {
    const peak = new Date(Date.UTC(2026, 9, 21, 2, 0));
    const cost = computeCost('deepseek-flash', usage(1_000_000, 1_000_000), peak);
    assert.ok(cost);
    assert.equal(cost.peak, true);
    assert.ok(Math.abs(cost.usd - 1.5) < 1e-9);
});

test('V4 Pro 价格独立计算', () => {
    const offPeak = new Date(Date.UTC(2026, 9, 21, 12, 0));
    const cost = computeCost('deepseek-v4-pro', usage(1_000_000, 1_000_000), offPeak);
    assert.ok(cost);
    assert.ok(Math.abs(cost.usd - (0.66 + 1.98)) < 1e-9);
});

test('缓存命中按更低单价计算', () => {
    const offPeak = new Date(Date.UTC(2026, 9, 21, 12, 0));
    const cost = computeCost(
        'deepseek-flash',
        usage(1_000_000, 0, { cacheHitTokens: 1_000_000, cacheMissTokens: 0 }),
        offPeak
    );
    assert.ok(cost);
    assert.equal(cost.inputHit, 1_000_000);
    assert.equal(cost.inputMiss, 0);
    assert.ok(Math.abs(cost.usd - 0.003) < 1e-9);
});

test('没有缓存明细时按全部未命中估算', () => {
    const offPeak = new Date(Date.UTC(2026, 9, 21, 12, 0));
    const cost = computeCost('deepseek-flash', usage(1_000_000, 0), offPeak);
    assert.ok(cost);
    assert.equal(cost.inputHit, 0);
    assert.equal(cost.inputMiss, 1_000_000);
    assert.ok(Math.abs(cost.usd - 0.15) < 1e-9);
});

test('未知模型不估算花费', () => {
    assert.equal(computeCost('my-gateway-model', usage(1000, 1000)), undefined);
    assert.equal(computeCost('', usage(1, 1)), undefined);
});

test('金额格式化：小额保留足够的小数位', () => {
    assert.equal(formatMoney(0.75, 'USD', 7.2), '$0.750');
    assert.equal(formatMoney(0.00012, 'USD', 7.2), '$0.0001');
    assert.equal(formatMoney(0.000001, 'USD', 7.2), '<$0.0001');
    assert.equal(formatMoney(0.75, 'CNY', 7.2), '¥5.40');
    assert.equal(formatMoney(0.00001, 'CNY', 7.2), '<¥0.001');
    assert.equal(formatMoney(0, 'CNY', 7.2), '¥0');
});

test('提示文案包含输入、输出、峰谷与两种货币', () => {
    const peak = new Date(Date.UTC(2026, 9, 21, 2, 0));
    const cost = computeCost('deepseek-flash', usage(1200, 300, { cacheHitTokens: 200, cacheMissTokens: 1000 }), peak);
    assert.ok(cost);
    const tooltip = formatCostTooltip(cost, 'CNY', 7.2);
    assert.match(tooltip, /输入 1,200 tokens/);
    assert.match(tooltip, /缓存命中 200/);
    assert.match(tooltip, /输出 300 tokens/);
    assert.match(tooltip, /峰时价/);
    assert.match(tooltip, /≈\$/);
});

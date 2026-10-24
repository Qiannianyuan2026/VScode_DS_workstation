import type { Usage } from './types';

/**
 * DeepSeek 官方价格（USD / 1M tokens，2026-10 抓取）。
 * 官方规则：谷时价为峰时价的一半；峰时为周一至周五 UTC 01:00–04:00、06:00–10:00
 * （北京时间 09:00–12:00、14:00–18:00），其余时段（含周末与中国法定节假日）为谷时。
 * 这里按 UTC 星期与时段判断，未内置中国节假日表，节假日会按峰时估算（偏保守）。
 */

export type Currency = 'USD' | 'CNY';

export interface ModelPrice {
    inputCacheHit: number;
    inputCacheMiss: number;
    output: number;
}

interface PriceTier {
    peak: ModelPrice;
    offPeak: ModelPrice;
}

const FLASH: PriceTier = {
    peak: { inputCacheHit: 0.006, inputCacheMiss: 0.3, output: 1.2 },
    offPeak: { inputCacheHit: 0.003, inputCacheMiss: 0.15, output: 0.6 },
};

const V4_PRO: PriceTier = {
    peak: { inputCacheHit: 0.044, inputCacheMiss: 1.32, output: 3.96 },
    offPeak: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
};

const PRICES: Record<string, PriceTier> = {
    'deepseek-flash': FLASH,
    'deepseek-v4-flash': FLASH,
    'deepseek-v4-flash-vision-exp': FLASH,
    'deepseek-v4-pro': V4_PRO,
};

export function isPeakTime(date: Date): boolean {
    const day = date.getUTCDay();
    if (day === 0 || day === 6) {
        return false;
    }
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

export interface CostBreakdown {
    usd: number;
    peak: boolean;
    model: string;
    price: ModelPrice;
    inputHit: number;
    inputMiss: number;
    output: number;
}

/** 按实际用量与请求时刻算出这一次请求的美元花费；未知模型返回 undefined。 */
export function computeCost(model: string, usage: Usage, at: Date = new Date()): CostBreakdown | undefined {
    const tier = PRICES[model?.trim()];
    if (!tier) {
        return undefined;
    }

    const peak = isPeakTime(at);
    const price = peak ? tier.peak : tier.offPeak;
    const inputHit = Math.max(0, usage.cacheHitTokens ?? 0);
    const inputMiss =
        usage.cacheMissTokens !== undefined
            ? Math.max(0, usage.cacheMissTokens)
            : Math.max(0, usage.promptTokens - inputHit);
    const output = Math.max(0, usage.completionTokens);

    const usd = (inputHit * price.inputCacheHit + inputMiss * price.inputCacheMiss + output * price.output) / 1_000_000;
    return { usd, peak, model, price, inputHit, inputMiss, output };
}

function cnyText(usd: number, usdToCny: number): string {
    const cny = usd * usdToCny;
    if (cny <= 0) {
        return '¥0';
    }
    if (cny < 0.0005) {
        return '<¥0.001';
    }
    if (cny < 0.01) {
        return `¥${cny.toFixed(3)}`;
    }
    if (cny < 10) {
        return `¥${cny.toFixed(2)}`;
    }
    return `¥${cny.toFixed(1)}`;
}

function usdText(usd: number): string {
    if (usd <= 0) {
        return '$0';
    }
    if (usd < 0.00005) {
        return '<$0.0001';
    }
    if (usd < 0.01) {
        return `$${usd.toFixed(4)}`;
    }
    if (usd < 10) {
        return `$${usd.toFixed(3)}`;
    }
    return `$${usd.toFixed(2)}`;
}

/** 按设置里的货币展示；两种货币都会在 tooltip 里给出。 */
export function formatMoney(usd: number, currency: Currency, usdToCny: number): string {
    return currency === 'CNY' ? cnyText(usd, usdToCny) : usdText(usd);
}

function count(value: number): string {
    return value.toLocaleString('en-US');
}

/** 消息 hover 提示：数量、缓存命中、峰谷价与两种货币金额。 */
export function formatCostTooltip(cost: CostBreakdown, currency: Currency, usdToCny: number): string {
    const input = cost.inputHit + cost.inputMiss;
    const priceLabel = cost.peak ? '峰时价' : '谷时价';
    const primary = formatMoney(cost.usd, currency, usdToCny);
    const secondary = currency === 'CNY' ? usdText(cost.usd) : cnyText(cost.usd, usdToCny);
    const note = '按官方牌价估算；中国法定节假日未单独排除';
    return (
        `输入 ${count(input)} tokens（缓存命中 ${count(cost.inputHit)}，未命中 ${count(cost.inputMiss)}）` +
        ` · 输出 ${count(cost.output)} tokens · ${priceLabel} · ${primary}（≈${secondary}）· ${note}`
    );
}

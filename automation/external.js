const config = require('./config');

const cache = {
    timestamp: 0,
    data: null
};

async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            headers: {
                'User-Agent': 'EdgeX-Bot/1.0'
            },
            signal: controller.signal
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
}

function toNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function computeMomentum(klines) {
    if (!Array.isArray(klines) || klines.length === 0) {
        return {};
    }

    const closesAll = klines.map(item => toNumber(item[4]));
    const volumesAll = klines.map(item => toNumber(item[5]));
    const highsAll = klines.map(item => toNumber(item[2]));
    const lowsAll = klines.map(item => toNumber(item[3]));

    const closes = closesAll.filter(Number.isFinite);
    const volumes = volumesAll.filter(Number.isFinite);
    const highs = highsAll.filter(Number.isFinite);
    const lows = lowsAll.filter(Number.isFinite);

    const latestClose = closes[closes.length - 1];
    const safeChange = (len) => {
        if (!Number.isFinite(latestClose)) return null;
        const idx = closes.length - 1 - len;
        if (idx < 0 || !Number.isFinite(closes[idx])) return null;
        const prev = closes[idx];
        return ((latestClose - prev) / prev) * 100;
    };

    const sumVolumes = (count, offset = 0) => {
        if (!Array.isArray(volumes) || volumes.length === 0) return null;
        const end = volumes.length - offset;
        const start = Math.max(0, end - count);
        if (start >= end) return null;
        return volumes.slice(start, end).reduce((acc, value) => acc + value, 0);
    };

    const change1m = safeChange(1);
    const change5m = safeChange(5);
    const change15m = safeChange(15);
    const change30m = safeChange(30);
    const change60m = safeChange(60);
    const change240m = safeChange(240);

    const recentVol5 = sumVolumes(5);
    const prevVol5 = sumVolumes(5, 5);
    const volumeSpikeRatio = (recentVol5 && prevVol5)
        ? (recentVol5 / prevVol5)
        : null;

    const highRange = (highs.length > 0 && lows.length > 0 && Number.isFinite(latestClose))
        ? ((Math.max(...highs) - Math.min(...lows)) / latestClose) * 100
        : null;

    // ATR14 计算
    let atr14 = null;
    if (Array.isArray(highsAll) && Array.isArray(lowsAll) && Array.isArray(closesAll) && klines.length >= 15) {
        const period = 14;
        const trueRanges = [];
        for (let i = klines.length - period; i < klines.length; i += 1) {
            const high = toNumber(klines[i][2]);
            const low = toNumber(klines[i][3]);
            const prevClose = toNumber(klines[i - 1]?.[4]);
            if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            if (Number.isFinite(tr)) {
                trueRanges.push(tr);
            }
        }
        if (trueRanges.length >= period) {
            atr14 = trueRanges.reduce((acc, value) => acc + value, 0) / trueRanges.length;
        }
    }

    return {
        change1m,
        change5m,
        change15m,
        change30m,
        change60m,
        change240m,
        volumeSpikeRatio,
        rangePct: highRange,
        atr14
    };
}

function buildSnapshot({ ticker, klines, premium, openInterest }, currentPrice) {
    const spotLastPrice = toNumber(ticker?.lastPrice);
    const markPrice = toNumber(premium?.markPrice);
    const indexPrice = toNumber(premium?.indexPrice);
    const fundingRate = toNumber(premium?.lastFundingRate);
    const predictedFundingRate = toNumber(premium?.estimatedSettlePrice);

    const momentum = computeMomentum(klines);

    const snapshot = {
        source: 'binance',
        symbol: ticker?.symbol ?? config.externalMarket.symbol,
        fetchedAt: Date.now(),
        spot: {
            lastPrice: spotLastPrice,
            priceChangePercent: toNumber(ticker?.priceChangePercent),
            highPrice: toNumber(ticker?.highPrice),
            lowPrice: toNumber(ticker?.lowPrice),
            volume24h: toNumber(ticker?.volume),
            quoteVolume24h: toNumber(ticker?.quoteVolume)
        },
        momentum,
        futures: {
            markPrice,
            indexPrice,
            fundingRate: fundingRate,
            fundingRatePercent: Number.isFinite(fundingRate) ? fundingRate * 100 : null,
            nextFundingTime: premium?.nextFundingTime ? Number(premium.nextFundingTime) : null,
            basisSpot: Number.isFinite(spotLastPrice) && Number.isFinite(indexPrice)
                ? spotLastPrice - indexPrice
                : null,
            openInterest: toNumber(openInterest?.openInterest)
        },
        config: {
            klineInterval: config.externalMarket.klineInterval,
            klineLimit: config.externalMarket.klineLimit
        }
    };

    const basisPerp = Number.isFinite(currentPrice) && Number.isFinite(spotLastPrice)
        ? currentPrice - spotLastPrice
        : null;

    const basisMark = Number.isFinite(currentPrice) && Number.isFinite(markPrice)
        ? currentPrice - markPrice
        : null;

    snapshot.relative = {
        basisVsSpot: basisPerp,
        basisVsMark: basisMark,
        basisSpotVsIndex: snapshot.futures.basisSpot,
        predictedFundingRatePercent: Number.isFinite(predictedFundingRate)
            ? predictedFundingRate * 100
            : null
    };

    return snapshot;
}

function prepareReturn(currentPrice) {
    if (!cache.data) return null;
    const cloned = JSON.parse(JSON.stringify(cache.data));
    const basisPerp = Number.isFinite(currentPrice) && Number.isFinite(cloned.spot?.lastPrice)
        ? currentPrice - cloned.spot.lastPrice
        : null;
    const basisMark = Number.isFinite(currentPrice) && Number.isFinite(cloned.futures?.markPrice)
        ? currentPrice - cloned.futures.markPrice
        : null;
    cloned.relative = {
        ...cloned.relative,
        basisVsSpot: basisPerp,
        basisVsMark: basisMark
    };
    return cloned;
}

async function getSnapshot(currentPrice) {
    const cfg = config.externalMarket;
    if (!cfg?.enabled) return null;

    const now = Date.now();
    if (cache.data && (now - cache.timestamp) < (cfg.ttl * 1000)) {
        return prepareReturn(currentPrice);
    }

    try {
        const timeout = cfg.timeoutMs || 10_000;
        const [ticker, klines, premium, openInterest] = await Promise.all([
            fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${cfg.symbol}`, timeout),
            fetchJson(`https://api.binance.com/api/v3/klines?symbol=${cfg.symbol}&interval=${cfg.klineInterval}&limit=${cfg.klineLimit}`, timeout),
            fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cfg.futuresSymbol || cfg.symbol}`, timeout),
            fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${cfg.futuresSymbol || cfg.symbol}`, timeout)
        ]);

        const base = buildSnapshot({ ticker, klines, premium, openInterest }, currentPrice);
        cache.timestamp = now;
        cache.data = base;
        return prepareReturn(currentPrice);
    } catch (error) {
        console.warn('[bot] 外部行情数据获取失败:', error.message);
        return prepareReturn(currentPrice);
    }
}

module.exports = {
    getSnapshot
};

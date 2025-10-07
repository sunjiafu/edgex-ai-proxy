const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

// OpenAI v4+ 正确写法
const { OpenAI } = require("openai");
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY 
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 安全工具函数
function safe(val, def) {
    return val === undefined || val === null || (typeof val === "number" && isNaN(val)) ? def : val;
}

function formatNumber(val, fractionDigits = 2) {
    if (val === undefined || val === null) return '未知';
    const num = Number(val);
    if (!Number.isFinite(num)) return '未知';
    return num.toFixed(fractionDigits);
}

function formatPercent(val, fractionDigits = 2) {
    const num = Number(val);
    if (!Number.isFinite(num)) return '未知';
    return `${num.toFixed(fractionDigits)}%`;
}

function formatExternalMarket(externalMarket) {
    if (!externalMarket) {
        return '外部行情: 未获取';
    }

    const ticker = externalMarket.ticker || {};
    const latestKlines = Array.isArray(externalMarket.klines)
        ? externalMarket.klines.slice(-5)
        : [];

    const klineSummary = latestKlines.length > 0
        ? latestKlines.map(item =>
            `${new Date(item.openTime).toISOString().slice(11,16)}开${formatNumber(item.open)}收${formatNumber(item.close)}量${formatNumber(item.volume, 3)}`
        ).join(' | ')
        : '无K线数据';

    return `外部行情（来源: ${externalMarket.source || '未知'}，交易对: ${externalMarket.symbol || '未知'}）:
- 24h 涨跌幅: ${formatNumber(ticker.priceChangePercent)}%
- 24h 交易量: ${formatNumber(ticker.volume, 3)}
- 24h 计价量: ${formatNumber(ticker.quoteVolume, 3)}
- 24h 最高价: ${formatNumber(ticker.highPrice)}
- 24h 最低价: ${formatNumber(ticker.lowPrice)}
- 最新价格: ${formatNumber(ticker.lastPrice)}
- 最近K线(每根${externalMarket.klineInterval || '未知'}): ${klineSummary}`;
}

app.post('/ai-decision', async (req, res) => {
    try {
        // 接收前端发送的完整交易数据
        const {
            symbol, currentPrice, priceHistory, indicators, position, tradingStats, priceChange, externalMarket
        } = req.body;

        const externalBlock = formatExternalMarket(externalMarket);
        const priceHistoryDisplay = Array.isArray(priceHistory)
            ? priceHistory.slice(-Math.min(priceHistory.length, 20)).map(p => formatNumber(p)).join(", ")
            : '未知';

        const pauseUntil = Number(tradingStats?.riskPauseUntil ?? 0);
        const pauseRemaining = pauseUntil > Date.now()
            ? Math.ceil((pauseUntil - Date.now()) / 60000)
            : 0;

        // 构建AI分析prompt
        const prompt = `
你是专业的加密货币量化交易策略AI。请分析以下数据并给出交易建议：

交易对: ${safe(symbol, '未知')}
当前价格: ${safe(currentPrice, '未知')}
价格历史: ${priceHistoryDisplay}
技术指标:
- 均线: MA5 ${formatNumber(indicators?.ma5)}, MA8 ${formatNumber(indicators?.ma8)}, MA20 ${formatNumber(indicators?.ma20)}
- EMA: EMA12 ${formatNumber(indicators?.ema12)}, EMA26 ${formatNumber(indicators?.ema26)}
- MACD: Diff ${formatNumber(indicators?.macd)}, Signal ${formatNumber(indicators?.macdSignal)}, Hist ${formatNumber(indicators?.macdHistogram)}
- RSI14: ${formatNumber(indicators?.rsi14)}
- 布林带: 上 ${formatNumber(indicators?.bollinger?.upper)}, 中 ${formatNumber(indicators?.bollinger?.basis)}, 下 ${formatNumber(indicators?.bollinger?.lower)}, 带宽 ${formatPercent(indicators?.bollinger?.bandwidth * 100)}
- 波动率: ${formatPercent(indicators?.volatility)}
- 动量: 1周期开 ${formatPercent(indicators?.roc1)}, 5周期 ${formatPercent(indicators?.roc5)}, 10周期 ${formatPercent(indicators?.roc10)}
- 趋势方向: ${safe(indicators?.trend, '未知')}
价格变化: ${typeof priceChange === 'number' ? priceChange.toFixed(2) + "%" : '未知'}
当前持仓: ${(position && position.hasPosition) ? 
    `${position.direction} ${position.size}` : '无持仓'}
交易统计:
- 累计交易 ${tradingStats?.totalTrades || 0} 次，总成交量 ${formatNumber(tradingStats?.totalVolume)}
- 累计盈亏 ${formatNumber(tradingStats?.realizedPnl)}，当日盈亏 ${formatNumber(tradingStats?.dailyRealized)}
- 连续亏损次数 ${tradingStats?.consecutiveLosses || 0}
- 风险暂停剩余 ${pauseRemaining > 0 ? `${pauseRemaining} 分钟` : '无'}
${externalBlock}

基于以上数据，请给出交易建议。只能回复以下三个词之一，除非出现明显的风险或欠缺信号，否则在buy/sell中择优，hold 只有在波动极低或多空概率接近时才使用：
- buy：建议买入/做多
- sell：建议卖出/做空  
- hold：建议观望/不操作

请只回复一个词，不要任何解释。
`;

        // 调用OpenAI API (v4+写法)
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: "system", 
                    content: "你是专业量化交易AI，严格按要求只回复buy、sell或hold中的一个词。"
                },
                {
                    role: "user", 
                    content: prompt
                }
            ],
            max_tokens: 10,
            temperature: 0.1
        });

        // 提取并验证AI回复
        let reply = completion.choices[0].message.content.trim().toLowerCase();
        
        // 确保回复格式正确
        if (!/^(buy|sell|hold)$/.test(reply)) {
            console.warn('AI回复格式异常:', reply, '默认使用hold');
            reply = 'hold';
        }

        console.log(`[${new Date().toISOString()}] AI决策: ${reply} (${symbol} @ ${currentPrice})`);
        
        res.json({ 
            direction: reply,
            timestamp: Date.now(),
            model: 'gpt-3.5-turbo'
        });

    } catch (error) {
        console.error('AI决策服务错误:', error);
        
        // 错误时返回保守策略
        res.json({ 
            direction: 'hold', 
            error: error.message,
            timestamp: Date.now()
        });
    }
});

// 健康检查接口
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'EdgeX AI Decision Service',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// 服务状态接口
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// 启动服务
const PORT = process.env.PORT || 12345;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 EdgeX AI决策服务已启动`);
    console.log(`📡 监听端口: ${PORT}`);
    console.log(`🔑 OpenAI API: ${process.env.OPENAI_API_KEY ? '已配置' : '未配置'}`);
    console.log(`⏰ 启动时间: ${new Date().toISOString()}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在关闭服务...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('收到SIGINT信号，正在关闭服务...');
    process.exit(0);
});

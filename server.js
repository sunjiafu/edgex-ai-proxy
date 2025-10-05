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

app.post('/ai-decision', async (req, res) => {
    try {
        // 接收前端发送的完整交易数据
        const {
            symbol, currentPrice, priceHistory, indicators, position, tradingStats, priceChange
        } = req.body;

        // 构建AI分析prompt
        const prompt = `
你是专业的加密货币量化交易策略AI。请分析以下数据并给出交易建议：

交易对: ${safe(symbol, '未知')}
当前价格: ${safe(currentPrice, '未知')}
价格历史: ${Array.isArray(priceHistory) ? priceHistory.slice(-8).join(", ") : '未知'}
技术指标:
- MA5均线: ${safe(indicators?.ma5, '未计算')}
- MA8均线: ${safe(indicators?.ma8, '未计算')}
- 波动率: ${safe(indicators?.volatility, '未知')}%
- 趋势方向: ${safe(indicators?.trend, '未知')}
价格变化: ${typeof priceChange === 'number' ? priceChange.toFixed(2) + "%" : '未知'}
当前持仓: ${(position && position.hasPosition) ? 
    `${position.direction} ${position.size}` : '无持仓'}
交易统计: 已完成${tradingStats?.totalTrades || 0}次交易，总量${tradingStats?.totalVolume || 0}

基于以上数据，请给出交易建议。只能回复以下三个词之一：
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

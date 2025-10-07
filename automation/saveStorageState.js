const readline = require('readline');
const { chromium } = require('playwright');
const config = require('./config');

async function prompt(message) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    return new Promise(resolve => {
        rl.question(message, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

async function main() {
    if (config.userDataDir) {
        console.log('[bot] 已配置 PLAYWRIGHT_USER_DATA_DIR，不需要保存 storageState。');
        return;
    }

    console.log('[bot] 启动浏览器，请在弹出的窗口中完成 EdgeX 登录（包括钱包授权）。');
    const browser = await chromium.launch({ headless: false, channel: config.browserChannel });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(config.edgexUrl, { waitUntil: 'domcontentloaded' });

    await prompt('\n完成登录后按回车继续保存会话...');

    await context.storageState({ path: config.storageStatePath });
    await browser.close();

    console.log(`[bot] 会话状态已保存到 ${config.storageStatePath}`);
}

main().catch(error => {
    console.error('[bot] 保存会话失败:', error);
    process.exit(1);
});

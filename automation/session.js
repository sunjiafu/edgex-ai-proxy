const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');

async function createContext() {
    if (config.userDataDir) {
        const launchOptions = {
            headless: config.headless,
            channel: config.browserChannel,
            viewport: { width: 1420, height: 900 }
        };

        if (config.allowExtensions) {
            launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
        }

        if (config.browserArgs.length > 0) {
            launchOptions.args = config.browserArgs;
        }

        const context = await chromium.launchPersistentContext(config.userDataDir, launchOptions);
        const page = context.pages()[0] || await context.newPage();
        return {
            context,
            page,
            close: async () => {
                await context.close();
            }
        };
    }

    const browser = await chromium.launch({
        headless: config.headless,
        channel: config.browserChannel
    });

    const contextOptions = {};
    if (config.hasStorageState) {
        contextOptions.storageState = config.storageStatePath;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return {
        browser,
        context,
        page,
        close: async () => {
            await context.close();
            await browser.close();
        }
    };
}

async function ensureStorageState(context) {
    if (!config.userDataDir) {
        await context.storageState({ path: config.storageStatePath });
    }
}

module.exports = {
    createContext,
    ensureStorageState
};

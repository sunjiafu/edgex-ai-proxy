const selectors = require('./selectors');

async function ensureActiveOrderTab(page) {
    const tab = page.locator(selectors.activeOrderTab);
    if (await tab.count() === 0) return;
    const isActive = await tab.getAttribute('aria-selected');
    if (isActive === 'true') return;
    await tab.click({ timeout: 5000 });
    await page.waitForSelector(selectors.activeOrderPanel, { timeout: 5000 });
}

async function readCurrentPrice(page) {
    const locator = page.locator(selectors.price);
    if (await locator.count() === 0) return null;
    const text = await locator.first().textContent();
    if (!text) return null;
    const clean = text.replace(/,/g, '').trim();
    const value = Number.parseFloat(clean);
    return Number.isFinite(value) ? value : null;
}

async function readPosition(page) {
    const rows = page.locator(selectors.positionTableRow);
    if (await rows.count() === 0) {
        return null;
    }

    return rows.first().evaluate((row, selectors) => {
        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
        const directionEl = row.querySelector(selectors.positionDirection);
        const sizeEl = row.querySelector(selectors.positionSize);
        if (!directionEl || !sizeEl) {
            return null;
        }

        const directionText = normalize(directionEl.textContent || '');
        const direction = directionText.includes('做多') ? 'long' :
            (directionText.includes('做空') ? 'short' : null);
        const size = Number.parseFloat((sizeEl.textContent || '').replace(/,/g, ''));
        if (!direction || !Number.isFinite(size)) {
            return null;
        }

        return { direction, size };
    }, selectors);
}

async function readActiveOrders(page) {
    await ensureActiveOrderTab(page);
    const rows = page.locator(selectors.activeOrderRows);
    const count = await rows.count();
    if (count === 0) return [];

    return rows.evaluateAll((elements) => {
        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();
        const parseQty = (text) => {
            if (!text) return { filled: 0, total: 0 };
            const parts = text.split('/').map(part => Number.parseFloat(part.replace(/[^0-9.+-]/g, '')));
            return {
                filled: Number.isFinite(parts[0]) ? parts[0] : 0,
                total: Number.isFinite(parts[1]) ? parts[1] : 0
            };
        };

        return elements.map((row, index) => {
            const cells = row.querySelectorAll('th,td');
            if (!cells || cells.length < 4) return null;

            const priceText = normalize(cells[1]?.textContent || '');
            const quantityText = normalize(cells[2]?.textContent || '');
            const sideText = normalize(cells[3]?.textContent || '');
            const orderIdText = normalize(cells[5]?.textContent || '');
            const timeText = normalize(cells[6]?.textContent || '');

            const price = Number.parseFloat(priceText.replace(/,/g, ''));
            const { filled, total } = parseQty(quantityText);
            let side = null;
            if (sideText.includes('买')) side = 'buy';
            if (sideText.includes('卖')) side = 'sell';

            let orderTime = null;
            if (timeText) {
                const parsed = Date.parse(timeText.replace(/-/g, '/'));
                if (!Number.isNaN(parsed)) orderTime = parsed;
            }

            if (!Number.isFinite(price) || !side) {
                return null;
            }

            return {
                index,
                price,
                filledQty: filled,
                totalQty: total,
                side,
                orderId: orderIdText,
                orderTime
            };
        }).filter(Boolean);
    });
}

async function cancelOrder(page, orderIndex) {
    const row = page.locator(selectors.activeOrderRows).nth(orderIndex);
    if (await row.count() === 0) return false;
    const cancelButton = row.locator('button', { hasText: '取消' });
    if (await cancelButton.count() === 0) return false;
    await cancelButton.first().click({ timeout: 5000 });
    return true;
}

async function setReactInput(locator, value) {
    await locator.focus();
    await locator.fill('');
    await locator.type(String(value), { delay: 10 });
}

async function confirmTrade(page, side) {
    const texts = side === 'buy' ? selectors.confirmTexts.buy : selectors.confirmTexts.sell;
    const dialog = page.locator('[role="alertdialog"], [role="dialog"]').first();
    await dialog.waitFor({ timeout: 3000 }).catch(() => {});

    for (const text of texts) {
        const btn = page.locator('button', { hasText: text }).filter({
            hasNot: page.locator('button', { hasText: '取消' })
        }).first();
        if (await btn.count() > 0 && await btn.first().isVisible()) {
            await btn.first().click({ timeout: 5000, force: true });
            return true;
        }
    }

    const dialogBtn = page.locator('[role="dialog"] button.btn-primary:not(:has-text("取消")),' +
        '[role="alertdialog"] button.btn-primary:not(:has-text("取消"))').first();
    if (await dialogBtn.count() > 0) {
        await dialogBtn.click({ timeout: 5000, force: true });
        return true;
    }

    return false;
}

async function ensureLimitMode(page) {
    const candidates = [
        { selector: 'div[data-state][class*="cursor-pointer"]', text: /^限价$/ },
        { selector: 'div[data-state][class*="cursor-pointer"]', text: /^limit$/i },
        { selector: 'button[role="tab"]', text: /^限价$/ },
        { selector: 'button[role="tab"]', text: /^limit$/i },
        { selector: selectors.limitModeTab, text: /^限价$/ }
    ];

    let limitTab = null;

    for (const { selector, text } of candidates) {
        const tabLocator = page.locator(selector, { hasText: text }).first();
        if (await tabLocator.count() > 0) {
            const tabText = await tabLocator.innerText().catch(() => '');
            if (tabText && !/条件/.test(tabText)) {
                limitTab = tabLocator;
                break;
            }
        }
    }

    if (!limitTab || await limitTab.count() === 0) {
        limitTab = page.locator('div[data-state]', { hasText: /^限价$/ })
            .filter({ hasNot: page.locator('text=条件') })
            .first();
    }

    if (!limitTab || await limitTab.count() === 0) {
        return;
    }

    const state = await limitTab.getAttribute('data-state');
    if (state && state.toLowerCase() === 'active') {
        return;
    }

    await limitTab.click({ timeout: 3000 });
    await page.waitForTimeout(400);
    await page.waitForSelector(selectors.limitPriceInput, { timeout: 2000 }).catch(() => {});
}

async function dismissBlockingLayers(page) {
    const overlay = page.locator('div[data-state="open"][aria-hidden="true"]');
    if (await overlay.count() === 0) return;

    await page.keyboard.press('Escape').catch(() => {});
    try {
        await overlay.first().waitFor({ state: 'detached', timeout: 1000 });
    } catch (err) {
        // 如果仍存在遮罩，尝试点击遮罩以关闭
        try {
            await overlay.first().click({ timeout: 500, trial: true });
            await overlay.first().click({ timeout: 500 });
        } catch (innerErr) {
            // ignore
        }
    }
}

async function findVisibleInput(root, selectorsList) {
    for (const selector of selectorsList) {
        const locator = root.locator(selector).first();
        try {
            await locator.waitFor({ timeout: 1000, state: 'visible' });
            return locator;
        } catch (err) {
            // ignore and try next selector
        }
    }
    return null;
}

async function placeLimitOrder(page, { side, price, size }) {
    await ensureLimitMode(page);

    const actionButton = page.locator(side === 'buy' ? selectors.buyButton : selectors.sellButton).first();
    await actionButton.waitFor({ timeout: 5000, state: 'visible' });

    const container = page.locator(selectors.orderContainer).filter({
        has: actionButton
    }).first();

    const inputRoot = (await container.count() > 0) ? container : page;
    const priceInput = await findVisibleInput(inputRoot, [
        'input[placeholder="委托价格"]',
        'input[placeholder*="价格"]',
        'input[data-testid="order-price"]'
    ]);

    const amountInput = await findVisibleInput(inputRoot, [
        'input[id="orderSizeValue"]',
        'input[placeholder="委托数量"]',
        'input[name="size"]'
    ]);

    if (!priceInput || !amountInput) {
        throw new Error('未能定位到限价输入框');
    }

    await priceInput.scrollIntoViewIfNeeded();
    await amountInput.scrollIntoViewIfNeeded();

    await setReactInput(priceInput, price.toFixed(2));
    await setReactInput(amountInput, size);

    await dismissBlockingLayers(page);
    await actionButton.click({ timeout: 5000, force: true });
    const confirmed = await confirmTrade(page, side);
    return confirmed;
}

module.exports = {
    ensureActiveOrderTab,
    readCurrentPrice,
    readPosition,
    readActiveOrders,
    cancelOrder,
    placeLimitOrder
};

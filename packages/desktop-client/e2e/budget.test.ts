import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';
import type { BudgetPage } from './page-models/budget-page';
import { ConfigurationPage } from './page-models/configuration-page';
import { Navigation } from './page-models/navigation';

test.describe('Budget', () => {
  let page: Page;
  let configurationPage: ConfigurationPage;
  let budgetPage: BudgetPage;
  let navigation: Navigation;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    configurationPage = new ConfigurationPage(page);
    navigation = new Navigation(page);

    await page.goto('/');
    budgetPage = await configurationPage.createTestFile();

    // Move mouse to corner of the screen;
    // sometimes the mouse hovers on a budget element thus rendering an input box
    // and this breaks screenshot tests
    await page.mouse.move(0, 0);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('renders the summary information: available funds, overspent, budgeted and for next month', async () => {
    const summary = budgetPage.budgetSummary.first();

    await expect(summary.getByText('Available funds')).toBeVisible({
      timeout: 10000,
    });
    await expect(summary.getByText(/^Overspent in /)).toBeVisible();
    await expect(summary.getByText('Budgeted')).toBeVisible();
    await expect(summary.getByText('For next month')).toBeVisible();
    await expect(page).toMatchThemeScreenshots();
  });

  test('transfer funds to another category', async () => {
    const currentFundsA = await budgetPage.getBalanceForRow(1);
    const currentFundsB = await budgetPage.getBalanceForRow(2);

    await budgetPage.transferAllBalance(1, 2);

    await expect
      .poll(() => budgetPage.getBalanceForRow(2))
      .toEqual(currentFundsA + currentFundsB);
    await expect(page).toMatchThemeScreenshots();
  });

  test('budget table is rendered', async () => {
    await expect(budgetPage.budgetTable).toBeVisible();
    expect(await budgetPage.getTableTotals()).toEqual({
      budgeted: expect.any(Number),
      spent: expect.any(Number),
      balance: expect.any(Number),
    });
  });

  test('clicking on spent amounts opens a transaction page', async () => {
    const accountPage = await budgetPage.clickOnSpentAmountForRow(1);
    expect(page.url()).toContain('/accounts');
    expect(await accountPage.accountName.textContent()).toMatch('All Accounts');
    await page.getByRole('button', { name: 'Back' }).click();
  });

  // ── TC-BT3 · Budget assignment updates available balance ─────────────────

  test('TC-BT3: assigning budget to a category updates the balance after a transaction', async () => {
    const rawName = await budgetPage.getCategoryNameForRow(1);
    if (!rawName) throw new Error('Could not read category name from row 1');
    const categoryName: string = rawName;

    // Zero out existing budget to get a known baseline, then set $200.
    // This avoids dependence on whatever demo data pre-seeded for this category.
    await budgetPage.setBudgetedAmount(categoryName, '0');
    const balanceAtZero = await budgetPage.getBalanceForRow(1);
    await budgetPage.setBudgetedAmount(categoryName, '200');
    const balanceAfter = await budgetPage.getBalanceForRow(1);
    expect(balanceAfter - balanceAtZero).toBe(20_000); // $200 = 20 000 cents

    // Navigate away and back — balance must be unchanged (persistence confirmed)
    await budgetPage.clickOnSpentAmountForRow(1);
    await page.getByRole('button', { name: 'Back' }).click();

    budgetPage = await navigation.goToBudgetPage();
    const balanceAfterReturn = await budgetPage.getBalanceForRow(1);
    expect(balanceAfterReturn).toBe(balanceAfter);
  });

  // ── TC-BT5 · Spending against a category reduces its balance ────────────

  test('TC-BT5: adding a debit transaction reduces the category balance by the transaction amount', async () => {
    // Row 1 is a known category row (proven by the transfer-funds test)
    const rawName = await budgetPage.getCategoryNameForRow(1);
    if (!rawName) throw new Error('Could not read category name from row 1');
    const categoryName: string = rawName;

    // Capture the starting balance (in cents) before any changes
    const balanceBefore = await budgetPage.getBalanceForRow(1);

    // Use Ally Savings — the same account used by all other transaction tests,
    // confirmed to be on-budget and to accept category assignments.
    const accountPage = await navigation.goToAccountPage('Ally Savings');
    await accountPage.createSingleTransaction({
      payee: 'Overspend Test',
      category: categoryName,
      debit: '100.00',
    });

    // Return to budget and verify the balance dropped by $100 (10 000 cents)
    budgetPage = await navigation.goToBudgetPage();
    const balanceAfter = await budgetPage.getBalanceForRow(1);

    expect(balanceBefore - balanceAfter).toBe(10_000); // $100 debit = 10 000 cents
  });
});

test.describe('Budget scroll position', () => {
  let page: Page;
  let configurationPage: ConfigurationPage;
  let budgetPage: BudgetPage;

  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage();
    configurationPage = new ConfigurationPage(page);

    await page.goto('/');
    budgetPage = await configurationPage.createTestFile();

    // Add enough categories to make the budget table scrollable.
    const categoryCount = 20;
    await page.evaluate(async count => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const $send = (window as any).$send as (
        type: string,
        args?: unknown,
      ) => Promise<string>;
      const groupId = await $send('category-group-create', {
        name: 'Extra Categories',
      });
      for (let i = 1; i <= count; i++) {
        await $send('category-create', { name: `Category ${i}`, groupId });
      }
      // Invalidate the category query so React re-renders with the new categories.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__TANSTACK_QUERY_CLIENT__.invalidateQueries({
        queryKey: ['categories', 'lists'],
      });
    }, categoryCount);
    await page
      .getByText(`Category ${categoryCount}`, { exact: true })
      .waitFor({ state: 'visible' });

    await page.mouse.move(0, 0);
  });

  test.afterEach(async () => {
    await page?.close();
  });

  test('scroll position is restored when navigating back from spent transactions page', async () => {
    await budgetPage.scrollToBottom();
    const scrollTopBeforeViewingSpent = await budgetPage.getScrollTop();
    expect(scrollTopBeforeViewingSpent).toBeGreaterThan(0);

    // Click a spent-amount cell that is already visible at the current scroll position so the scroll does not change
    // before the handler captures it.
    await budgetPage.clickOnSpentAmountForLastVisibleRow();
    expect(page.url()).toContain('/accounts');

    await page.getByRole('button', { name: 'Back' }).click();
    await budgetPage.waitFor();

    const scrollTopAfterReturningFromSpent = await budgetPage.getScrollTop();
    expect(scrollTopAfterReturningFromSpent).toBe(scrollTopBeforeViewingSpent);
  });
});

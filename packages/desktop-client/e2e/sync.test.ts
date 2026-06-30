/**
 * Sync E2E tests — TC-S1 through TC-S4
 *
 * Prerequisites:
 *   SYNC_SERVER_URL  — URL of the running sync server (e.g. http://localhost:5006)
 *   SYNC_SERVER_PASSWORD — password for the sync server (omit if no password set)
 *
 * Each test spins up two browser contexts (Device A and Device B) that both
 * connect to the same sync server and open the same cloud budget file.
 */

import type { BrowserContext, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { AccountPage } from './page-models/account-page';
import { BudgetPage } from './page-models/budget-page';
import { Navigation } from './page-models/navigation';
import { SyncPage } from './page-models/sync-page';

const SYNC_SERVER_URL = process.env.SYNC_SERVER_URL ?? '';
const SYNC_SERVER_PASSWORD = process.env.SYNC_SERVER_PASSWORD ?? '';
const BASE_URL = process.env.E2E_START_URL ?? 'http://localhost:3001';

const hasSyncServer = !!SYNC_SERVER_URL;

/**
 * Connect a browser context to the sync server and open the shared budget.
 * Returns once the budget page is fully loaded.
 */
async function connectToSyncServer(
  page: Page,
  serverUrl: string,
  password: string,
): Promise<BudgetPage> {
  await page.goto(BASE_URL);

  // If there is already a "Use a server" button on the welcome screen, click it
  const useServerButton = page.getByRole('button', { name: /use a server/i });
  if (await useServerButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await useServerButton.click();
  }

  // Fill the server URL field if it appears (ConfigServer screen)
  const serverUrlInput = page.getByLabel(/server url/i);
  if (await serverUrlInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await serverUrlInput.fill(serverUrl);
    await page.getByRole('button', { name: /ok|connect|save/i }).click();
  }

  // Authenticate if a password field appears
  const passwordInput = page.getByPlaceholder(/password/i);
  if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await passwordInput.fill(password);
    await page.getByRole('button', { name: /sign in|login/i }).click();
  }

  // Wait for the budget file list and open the first budget
  const firstBudget = page.getByRole('button', { name: /open/i }).first();
  await firstBudget.waitFor({ timeout: 10_000 });
  await firstBudget.click();

  const budgetPage = new BudgetPage(page);
  await budgetPage.waitFor();
  return budgetPage;
}

async function openSyncedBudgetInContext(
  context: BrowserContext,
  serverUrl: string,
  password: string,
): Promise<{
  page: Page;
  budgetPage: BudgetPage;
  navigation: Navigation;
  syncPage: SyncPage;
}> {
  const page = await context.newPage();
  const budgetPage = await connectToSyncServer(page, serverUrl, password);
  const navigation = new Navigation(page);
  const syncPage = new SyncPage(page);
  return { page, budgetPage, navigation, syncPage };
}

test.describe('Sync — CRDT consistency', () => {
  test.beforeEach(() => {
    if (!hasSyncServer) {
      throw new Error(
        'SYNC_SERVER_URL is not set — sync tests require a running sync server.',
      );
    }
  });

  // ── TC-S1 · Transaction propagates from Context A → Context B ────────────

  test('TC-S1: transaction created on device A appears on device B after sync', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const { navigation: navA, syncPage: syncA } =
        await openSyncedBudgetInContext(
          contextA,
          SYNC_SERVER_URL,
          SYNC_SERVER_PASSWORD,
        );

      const { navigation: navB, syncPage: syncB } =
        await openSyncedBudgetInContext(
          contextB,
          SYNC_SERVER_URL,
          SYNC_SERVER_PASSWORD,
        );

      // Device A: create account and transaction
      const accountPageA = await navA.createAccount({
        name: 'Sync-Test-TC-S1',
        balance: 0,
        offBudget: false,
      });

      await accountPageA.createSingleTransaction({
        payee: 'Grocery',
        debit: '42.00',
      });

      // Device A: sync up
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');

      // Device B: sync down
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      // Device B: verify transaction is visible
      const accountPageB = await navB.goToAccountPage('Sync-Test-TC-S1');
      await expect(accountPageB.getNthTransaction(0).payee).toHaveText(
        'Grocery',
      );
      await expect(accountPageB.getNthTransaction(0).debit).toHaveText('42.00');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  // ── TC-S2 · Offline → reconnect eventual consistency ─────────────────────

  test('TC-S2: transactions created while device B is offline are received after reconnect', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const { navigation: navA, syncPage: syncA } =
        await openSyncedBudgetInContext(
          contextA,
          SYNC_SERVER_URL,
          SYNC_SERVER_PASSWORD,
        );

      const { page: pageB, syncPage: syncB } = await openSyncedBudgetInContext(
        contextB,
        SYNC_SERVER_URL,
        SYNC_SERVER_PASSWORD,
      );

      // Device A: create first transaction and sync
      const accountPageA = await navA.goToAccountPage('Ally Savings');
      await accountPageA.createSingleTransaction({
        payee: 'Coffee',
        debit: '10.00',
      });
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');

      // Block sync on Device B
      await pageB.route('**/sync', route => route.abort());

      // Device A: create second transaction and sync (B can't receive it yet)
      await accountPageA.createSingleTransaction({
        payee: 'Lunch',
        debit: '20.00',
      });
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');

      // Unblock Device B and sync
      await pageB.unroute('**/sync');
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      // Device B: verify both transactions arrived
      const navB = new Navigation(pageB);
      const accountPageB = await navB.goToAccountPage('Ally Savings');
      const count = await accountPageB.transactionTableRow.count();
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  // ── TC-S3 · Network drop mid-sync recovers gracefully ────────────────────

  test('TC-S3: sync recovers after mid-sync network failure', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const {
        page: pageA,
        syncPage: syncA,
        navigation: navA,
      } = await openSyncedBudgetInContext(
        contextA,
        SYNC_SERVER_URL,
        SYNC_SERVER_PASSWORD,
      );

      const { syncPage: syncB, navigation: navB } =
        await openSyncedBudgetInContext(
          contextB,
          SYNC_SERVER_URL,
          SYNC_SERVER_PASSWORD,
        );

      // Device A: create a transaction, then interrupt the next sync
      const accountPageA = await navA.goToAccountPage('Ally Savings');
      await accountPageA.createSingleTransaction({
        payee: 'Dropped',
        debit: '5.00',
      });

      let requestCount = 0;
      await pageA.route('**/sync', async route => {
        requestCount++;
        if (requestCount === 1) {
          await route.abort(); // abort first sync attempt
        } else {
          await route.continue();
        }
      });

      // First attempt should fail/error
      await syncA.triggerSync();
      const stateAfterDrop = await syncA.getSyncState();
      expect(['error', 'offline', 'local']).toContain(stateAfterDrop);

      // Unblock and retry — should succeed
      await pageA.unroute('**/sync');
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');

      // Device B receives everything
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      const accountPageB = await navB.goToAccountPage('Ally Savings');
      const rows = await accountPageB.transactionTableRow.count();
      expect(rows).toBeGreaterThanOrEqual(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  // ── TC-S4 · Concurrent edit converges (last-writer-wins) ─────────────────

  test('TC-S4: concurrent edits to the same transaction converge to the same value', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const {
        page: pageA,
        navigation: navA,
        syncPage: syncA,
      } = await openSyncedBudgetInContext(
        contextA,
        SYNC_SERVER_URL,
        SYNC_SERVER_PASSWORD,
      );

      const {
        page: pageB,
        navigation: navB,
        syncPage: syncB,
      } = await openSyncedBudgetInContext(
        contextB,
        SYNC_SERVER_URL,
        SYNC_SERVER_PASSWORD,
      );

      // Ensure both contexts see the same initial state
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      // Both contexts navigate to the same account
      const accountPageA = await navA.goToAccountPage('Ally Savings');
      const accountPageB = await navB.goToAccountPage('Ally Savings');

      // Simultaneously edit notes on the first transaction from each device
      const txA = accountPageA.getNthTransaction(0);
      const txB = accountPageB.getNthTransaction(0);

      await Promise.all([
        // Device A edits notes
        (async () => {
          await txA.notes.click();
          await pageA.keyboard.type('Note from A');
          await pageA.keyboard.press('Enter');
        })(),
        // Device B edits notes
        (async () => {
          await txB.notes.click();
          await pageB.keyboard.type('Note from B');
          await pageB.keyboard.press('Enter');
        })(),
      ]);

      // Both sync
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      // Sync again so both receive each other's changes
      await syncA.triggerSync();
      expect(await syncA.getSyncState()).toBe('ok');
      await syncB.triggerSync();
      expect(await syncB.getSyncState()).toBe('ok');

      // Both should converge on the same notes value
      const notesA = await accountPageA
        .getNthTransaction(0)
        .notes.textContent();
      const notesB = await accountPageB
        .getNthTransaction(0)
        .notes.textContent();

      expect(notesA).toBeTruthy();
      expect(notesA).toBe(notesB);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

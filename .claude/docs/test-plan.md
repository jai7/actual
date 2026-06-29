# E2E Test Plan: Data Sync & Budget/Transaction Entry
**Actual Budget · Playwright · Senior QA Architect**

---

## Context

This plan covers two high-severity test flows that have no existing E2E coverage in the repo's current 52-test suite:

1. **Data Sync** — the CRDT sync-server path (`packages/sync-server/`) has zero Playwright tests today; all sync validation is done manually or implicitly through API integration tests.
2. **Budget & Transaction Entry** — partial coverage exists (`transactions.test.ts`, `budget.test.ts`) but the persistence-after-reload and full IPC lifecycle are not explicitly asserted.

The plan slots into the existing monorepo patterns: Page Object Models in `e2e/page-models/`, fixtures in `e2e/fixtures.ts`, Chromium-only, lage parallelism, CI on GitHub Actions.

---

## Repo Constraints Observed

| Constraint | Detail |
|---|---|
| **Test runner** | Playwright + Vitest; `playwright.config.ts` in `packages/desktop-client/` |
| **Workers** | 4 in CI (`process.env.CI`), system default locally |
| **Timeout** | 60 s per test, 10 s expect (AutoSizer layout delay) |
| **Browsers** | Chromium only |
| **Page Models** | All UI interaction in `e2e/page-models/*.ts`; tests never write raw locators |
| **Seeding** | `ConfigurationPage.createTestFile()` seeds demo data via UI; no direct DB access in tests |
| **Animations** | Globally disabled in `fixtures.ts` for deterministic interaction |
| **React Aria** | `clickReactAriaButton()` + `fillReactInput()` helpers in `navigation.ts` must be reused |
| **Programmatic IPC** | `page.evaluate(() => window.__actualdebug?.send('handler', args))` is the bridge for non-UI seeding if needed; confirmed via `window.Actual` exposure in preload |

---

## Flow 1 — Data Sync (CRDT)

### User Functions

| ID | Function | Description |
|---|---|---|
| SF-1 | Create & sync transaction | User creates a transaction on Device A; it appears on Device B after sync |
| SF-2 | Concurrent edit convergence | Both devices edit the same transaction field simultaneously; last-writer-wins semantics resolve deterministically |
| SF-3 | Offline → reconnect consistency | Device B goes offline, Device A makes changes, Device B reconnects and receives all changes |
| SF-4 | Sync status indicator | UI shows correct sync state badges (syncing / success / error) |

### Edge Conditions

| ID | Condition | How to Simulate |
|---|---|---|
| EC-S1 | Network drop mid-sync | Use `page.route('**/sync', route => route.abort())` on Context B during an in-flight sync |
| EC-S2 | Race: two transactions same timestamp | `page.evaluate()` to inject two rapid `send('transaction-add')` calls before sync flush |
| EC-S3 | Server restart between syncs | Stop and restart the sync-server Express process between Context A and Context B sync calls |
| EC-S4 | Large batch (50+ transactions) | Seed via `transactions-batch-update` handler before sync to stress the Merkle diff path |

### Test Cases

#### TC-S1 · Transaction propagates from Context A → Context B

**Priority:** P0
**New files:**
- `e2e/sync.test.ts`
- `e2e/page-models/sync-page.ts` (thin wrapper for multi-context helpers)

**Setup:**
```
1. Start sync server (already runs via `yarn start:server-dev`)
2. browserA = await browser.newContext()
3. browserB = await browser.newContext()
4. Each context navigates to localhost:3001
5. Each context: ConfigurationPage.createTestFile() → connects to same sync server URL
```

**Steps:**
```
1. pageA: Navigation.createAccount({ name: 'Sync-Test', balance: 0, offBudget: false })
2. pageA: accountPage.createSingleTransaction({ payee: 'Grocery', debit: '42.00' })
3. pageA: SyncPage.triggerSync()  → wait for sync-success badge
4. pageB: SyncPage.triggerSync()  → wait for sync-success badge
5. pageB: Navigation.goToAccountPage('Sync-Test')
6. Assert: accountPage.getNthTransaction(0).payee toHaveText('Grocery')
7. Assert: accountPage.getNthTransaction(0).debit toHaveText('42.00')
```

**Pass criteria:** Transaction visible in Context B without page reload.

---

#### TC-S2 · Offline → reconnect eventual consistency

**Priority:** P0

**Steps:**
```
1. pageA: create transaction T1 (debit: '10.00', payee: 'Coffee')
2. pageA: triggerSync() → success
3. Block sync on pageB:
     await pageB.route('**/sync', r => r.abort())
4. pageA: create transaction T2 (debit: '20.00', payee: 'Lunch')
5. pageA: triggerSync() → success
6. Unblock: await pageB.unroute('**/sync')
7. pageB: triggerSync() → success
8. Assert: both T1 and T2 visible on pageB account (count: 2)
```

**Pass criteria:** CRDT merge delivers both transactions; no duplicates.

---

#### TC-S3 · Network drop mid-sync recovers gracefully

**Priority:** P1

**Steps:**
```
1. pageA: create 5 transactions via transactions-batch-update
2. Intercept: pageA.route('**/sync', async route => {
     await route.continue()  // let request through
     await pageA.route('**/sync', r => r.abort())  // abort next sync
   })
3. pageA: triggerSync() → expect error/retry badge
4. Unblock route
5. pageA: triggerSync() → success
6. pageB: triggerSync() → success
7. Assert: all 5 transactions present on pageB
```

**Pass criteria:** No data loss after mid-sync failure; UI shows error then recovers.

---

#### TC-S4 · Concurrent edit converges (last-writer-wins)

**Priority:** P1

**Steps:**
```
1. pageA + pageB both synced to same account with transaction T
2. pageA: edit T.notes = 'Note from A' → sync
3. pageB: (simultaneously) edit T.notes = 'Note from B' → sync
4. Both contexts: sync again
5. Assert: both contexts show same notes value (either A or B, but IDENTICAL)
```

**Pass criteria:** No split-brain; both UIs converge to the same value.

---

### Page Model: `SyncPage`

New file: `e2e/page-models/sync-page.ts`

```typescript
export class SyncPage {
  readonly syncButton: Locator;
  readonly syncSuccessBadge: Locator;
  readonly syncErrorBadge: Locator;

  constructor(private page: Page) {
    this.syncButton = page.getByRole('button', { name: /sync/i });
    this.syncSuccessBadge = page.getByTestId('sync-success');
    this.syncErrorBadge = page.getByTestId('sync-error');
  }

  async triggerSync() {
    await this.syncButton.click();
    // wait for either success or error — don't sleep
    await Promise.race([
      this.syncSuccessBadge.waitFor({ state: 'visible' }),
      this.syncErrorBadge.waitFor({ state: 'visible' }),
    ]);
  }

  async waitForSuccess() {
    await this.syncSuccessBadge.waitFor({ state: 'visible', timeout: 15_000 });
  }
}
```

---

## Flow 2 — Budget & Transaction Entry

### User Functions

| ID | Function | Description |
|---|---|---|
| BT-1 | Create transaction (single) | Add a debit transaction; verify IPC write → UI re-render |
| BT-2 | Create split transaction | Split a transaction across two categories |
| BT-3 | Assign budget amount | Type amount into budget cell; verify category balance updates |
| BT-4 | Edit existing transaction | Modify payee/amount; verify update propagates |
| BT-5 | Persistence after reload | Data survives a `page.reload()` (SQLite flush confirmed) |
| BT-6 | Transfer between accounts | Create a transfer; verify mirrored entry in target account |

### Edge Conditions

| ID | Condition | How to Simulate |
|---|---|---|
| EC-B1 | Negative budget (overspending) | Budget $5, add $10 transaction → verify red balance cell |
| EC-B2 | Zero-amount transaction | Debit: '0.00' — should be accepted or show inline validation |
| EC-B3 | Large amount (integer overflow guard) | Debit: '9999999.99' — verify amount stored/displayed correctly |
| EC-B4 | Rapid successive entries | Add 10 transactions back-to-back without awaiting each render |

### Test Cases

#### TC-BT1 · Full transaction lifecycle: Entry → IPC → SQLite → Re-render

**Priority:** P0
**File:** `e2e/transactions.test.ts` (extend existing)

**Setup:**
```
ConfigurationPage.createTestFile()  // demo budget with pre-seeded accounts
accountPage = navigation.goToAccountPage('Checking Account')
```

**Steps:**
```
1. accountPage.createSingleTransaction({
     payee: 'Whole Foods',
     category: 'Food',
     debit: '55.23',
     notes: 'Weekly shop'
   })
2. const tx = accountPage.getNthTransaction(0)
3. Assert: tx.payee toHaveText('Whole Foods')
4. Assert: tx.debit toHaveText('55.23')
5. Assert: tx.category toHaveText('Food')
```

**Pass criteria:** All fields rendered after single await; no explicit sleep.

---

#### TC-BT2 · Persistence after reload

**Priority:** P0

**Steps:**
```
1. accountPage.createSingleTransaction({ payee: 'Netflix', debit: '15.00' })
2. await page.reload()
3. await page.waitForLoadState('networkidle')
4. accountPage = await navigation.goToAccountPage('Checking Account')
5. Assert: accountPage.getNthTransaction(0).payee toHaveText('Netflix')
```

**Pass criteria:** Transaction survives full page reload (SQLite write confirmed, not just in-memory).

---

#### TC-BT3 · Budget amount assignment updates available balance

**Priority:** P0
**File:** `e2e/budget.test.ts` (extend existing)

**Steps:**
```
1. budgetPage = navigation.goToBudgetPage()
2. await budgetPage.setBudgetAmount({ month: currentMonth, category: 'Food', amount: '200' })
3. Assert: budgetPage.getCategoryBalance('Food') toHaveText('200.00')
4. accountPage = navigation.goToAccountPage('Checking Account')
5. accountPage.createSingleTransaction({ category: 'Food', debit: '50.00' })
6. budgetPage = navigation.goToBudgetPage()
7. Assert: budgetPage.getCategoryBalance('Food') toHaveText('150.00')
```

**Pass criteria:** IPC `budget/budget-amount` call reflected in spreadsheet cell recalculation.

---

#### TC-BT4 · Split transaction assigns to two categories

**Priority:** P1

**Steps:**
```
1. accountPage.createSplitTransaction([
     { category: 'Food', debit: '30.00' },
     { category: 'Transport', debit: '20.00' }
   ])
2. const tx = accountPage.getNthTransaction(0)
3. Assert: tx.totalDebit toHaveText('50.00')
4. Expand split
5. Assert: child[0].category toHaveText('Food'), child[0].debit toHaveText('30.00')
6. Assert: child[1].category toHaveText('Transport'), child[1].debit toHaveText('20.00')
```

---

#### TC-BT5 · Overspending turns category balance red

**Priority:** P1

**Steps:**
```
1. budgetPage.setBudgetAmount({ category: 'Food', amount: '5' })
2. accountPage.createSingleTransaction({ category: 'Food', debit: '10.00' })
3. budgetPage = navigation.goToBudgetPage()
4. Assert: budgetPage.getCategoryBalanceEl('Food') toHaveCSS('color', /red|rgb\(.*\)/)
   OR
   Assert: budgetPage.getCategoryBalance('Food') toHaveText('-5.00')
```

---

#### TC-BT6 · Transfer creates mirrored entry

**Priority:** P1

**Steps:**
```
1. Create two accounts: 'Checking' (balance: 500) and 'Savings' (balance: 0)
2. checkingPage.createSingleTransaction({
     payee: 'Savings',   // payee backed by transfer_acct
     debit: '100.00'
   })
3. savingsPage = navigation.goToAccountPage('Savings')
4. Assert: savingsPage.getNthTransaction(0).credit toHaveText('100.00')
5. Assert: savingsPage.getNthTransaction(0).payee toHaveText('Checking')
```

---

### New Page Model Method: `BudgetPage.setBudgetAmount`

Extend `e2e/page-models/budget-page.ts`:

```typescript
async setBudgetAmount({
  month,
  category,
  amount,
}: {
  month?: string;
  category: string;
  amount: string;
}) {
  const cell = this.page
    .getByTestId(`budget-month-${month ?? 'current'}`)
    .getByTestId(`budget-amount-${category}`);
  await cell.click();
  await fillReactInput(cell.getByRole('textbox'), amount);
  await this.page.keyboard.press('Enter');
  // wait for cells-changed push event to re-render
  await this.page
    .waitForResponse(resp => resp.url().includes('/sync') || true, { timeout: 2000 })
    .catch(() => null);
}
```

---

## Isolation Strategy

Every test must be isolated. Two approaches, in priority order:

1. **Preferred:** `ConfigurationPage.createTestFile()` — creates a fresh in-memory SQLite budget per test; fastest and already used throughout the suite.
2. **For sync tests:** Each browser context calls `createTestFile()` independently, then connects to the same sync server with the same budget file URL. Since the demo file is deterministic, both contexts start from identical state.

Never share a budget file across tests in the same worker.

---

## CI Integration

**GitHub Actions parallelism:**

```yaml
# .github/workflows/e2e.yml (addendum)
- name: Run Sync E2E
  run: yarn workspace @actual-app/web run playwright test sync.test.ts --workers=2
  env:
    CI: true
    SYNC_SERVER_URL: http://localhost:5006

- name: Run Budget/Transaction E2E
  run: yarn workspace @actual-app/web run playwright test transactions.test.ts budget.test.ts --workers=4
  env:
    CI: true
```

- Sync tests use 2 workers (each test needs 2 browser contexts — don't oversubscribe)
- Budget/transaction tests use 4 workers (single-context, fully parallel)
- Sync server started via `yarn start:server-dev` in `webServer` config or a separate `globalSetup.ts`

**Playwright shard example for full suite:**
```yaml
strategy:
  matrix:
    shard: [1/4, 2/4, 3/4, 4/4]
steps:
  - run: yarn e2e --shard=${{ matrix.shard }}
```

---

## Verification

To confirm the plan works end-to-end before merging:

1. `yarn start:server-dev` (starts sync server on :5006 + frontend on :3001)
2. `yarn workspace @actual-app/web run playwright test sync.test.ts --headed` — observe two browser windows syncing live
3. `yarn workspace @actual-app/web run playwright test transactions.test.ts budget.test.ts` — all existing + new tests green
4. `yarn typecheck` — no type errors in new page model additions
5. `yarn lint:fix` — oxfmt + oxlint pass

---

## Files to Create / Modify

| File | Action |
|---|---|
| `packages/desktop-client/e2e/sync.test.ts` | **Create** — TC-S1 through TC-S4 |
| `packages/desktop-client/e2e/page-models/sync-page.ts` | **Create** — SyncPage POM |
| `packages/desktop-client/e2e/transactions.test.ts` | **Extend** — TC-BT1, TC-BT2, TC-BT4, TC-BT5, TC-BT6 |
| `packages/desktop-client/e2e/budget.test.ts` | **Extend** — TC-BT3, TC-BT5 |
| `packages/desktop-client/e2e/page-models/budget-page.ts` | **Extend** — `setBudgetAmount()`, `getCategoryBalance()` |
| `packages/desktop-client/playwright.config.ts` | **Extend** — add `SYNC_SERVER_URL` env, optional second webServer entry |

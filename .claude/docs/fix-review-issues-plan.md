# Plan: Fix E2E Test Review Issues

## Context

The E2E test suite was implemented across 5 tasks. A code review identified 4 structural issues:

1. `expect()` assertions live inside a page object (`SyncPage`) — POM should expose state, not assert
2. `test.skip(!hasSyncServer)` lets the sync suite pass green without running anything
3. `waitForLoadState('networkidle')` is discouraged — use element-based waits
4. Budget test assertions are too loose (`> 0`, `>= 9_000`) instead of exact arithmetic

## Files to Change

Only files touched in prior commits may be edited:

- `packages/desktop-client/e2e/page-models/sync-page.ts`
- `packages/desktop-client/e2e/sync.test.ts`
- `packages/desktop-client/e2e/transactions.test.ts`
- `packages/desktop-client/e2e/budget.test.ts`

---

## Fix 1 — Remove `expect()` from SyncPage

**File:** `e2e/page-models/sync-page.ts`

- Remove `import { expect }`
- `triggerSync()`: replace `expect(...).not.toHaveAttribute(...)` with a CSS attribute selector waitFor:
  ```ts
  await this.page
    .locator('[data-testid="sync-button"]:not([data-sync-state="syncing"])')
    .waitFor({ timeout: 15_000 });
  ```
- Delete `waitForSuccess()` and `waitForError()` entirely — tests will assert inline

---

## Fix 2 — Fail loudly when sync server not configured

**File:** `e2e/sync.test.ts`

- Remove `test.skip(!hasSyncServer, ...)` from the describe block
- Add a `test.beforeEach` that throws if `!hasSyncServer`:
  ```ts
  test.beforeEach(() => {
    if (!hasSyncServer) {
      throw new Error(
        'SYNC_SERVER_URL is not set — sync tests require a running sync server.',
      );
    }
  });
  ```
- Replace every `await syncX.waitForSuccess()` call with:
  ```ts
  expect(await syncX.getSyncState()).toBe('ok');
  ```
- Replace `await syncA.waitForError()` / error checks to use `getSyncState()` inline

---

## Fix 3 — Replace `networkidle` with element-based wait

**File:** `e2e/transactions.test.ts` — TC-BT2

Replace:

```ts
await page.reload();
await page.waitForLoadState('networkidle');
navigation = new Navigation(page);
accountPage = await navigation.goToAccountPage('Ally Savings');
```

With:

```ts
await page.reload();
navigation = new Navigation(page);
accountPage = await navigation.goToAccountPage('Ally Savings');
// goToAccountPage already waits for the account page to mount
```

`navigation.goToAccountPage()` internally uses `waitFor` on the account table, so `networkidle` is redundant and should simply be removed.

---

## Fix 4 — Tighten budget assertions to exact arithmetic

**File:** `e2e/budget.test.ts`

### TC-BT3

Current: checks `Number(balanceText) > 0` — meaningless against demo data with pre-existing credits.

Fix: capture balance _before_ budgeting, set $200, assert balance increased by exactly $200 (20 000 cents):

```ts
const balanceBefore = await budgetPage.getBalanceForRow(1);
await budgetPage.setBudgetedAmount(categoryName, '200');
const balanceAfter = await budgetPage.getBalanceForRow(1);
expect(balanceAfter - balanceBefore).toBe(20_000);
```

Drop `getCategoryBalance` (string-returning) in favour of `getBalanceForRow` (returns cents) for both reads.

For the navigation-roundtrip assertion, capture balance after return and assert it equals `balanceAfter` (unchanged):

```ts
budgetPage = await navigation.goToBudgetPage();
const balanceAfterReturn = await budgetPage.getBalanceForRow(1);
expect(balanceAfterReturn).toBe(balanceAfter);
```

### TC-BT5

Current: `expect(balanceBefore - balanceAfter).toBeGreaterThanOrEqual(9_000)` — too loose.

Fix: a $100 debit = exactly 10 000 cents decrease:

```ts
expect(balanceBefore - balanceAfter).toBe(10_000);
```

---

## Verification

After edits, run:

```bash
E2E_START_URL=http://localhost:3001 yarn workspace @actual-app/web run e2e budget.test.ts transactions.test.ts --reporter=list
```

Sync tests should now _fail_ (not skip) when `SYNC_SERVER_URL` is unset — that's the expected, correct behaviour.

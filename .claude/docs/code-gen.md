ROLE: Act as a Senior SDET (Software Development Engineer in Test) specializing in Playwright and TypeScript.

OBJECTIVE: Generate a production-ready Playwright E2E test suite based on the provided Test Plan @.claude/docs/test-plan.md

#### Technical Constraints & Patterns:

Page Object Model (POM): Create cohesive class files for the desktop-client views (e.g., BudgetPage, TransactionPage) to encapsulate internal structures
.
Programmatic Setup:
Do not use the UI for login or initial data setup unless that is the specific test focus
.
Implement a `test.beforeEach` hook that uses IPC calls to loot-core to initialize a fresh SQLite instance and seed necessary categories or accounts
.
Resilient Selectors: Prioritize user-facing ARIA roles (e.g., role="button") and `data-test-id` for targeting elements in the React frontend
.
Multi-Client Sync (Flow 1): Use multiple browser contexts to simulate distinct devices communicating via the sync-server [ tech stack context].
Deterministic Asynchrony: Strictly use Playwright’s auto-waiting and explicit locator assertions; do not use hard-coded `setTimeout` or `sleep`
.
Code Generation Instructions:
Infrastructure: Provide a `playwright.config.ts` that enables parallel execution but ensures each worker uses a unique SQLite file path to avoid state collision
.
Utility Layer: Create a `loot-core-helper.ts` to bridge Playwright's page.evaluate with the loot-core IPC handlers for direct database manipulation.

#### Test Case Implementation:
Flow 1 (Sync): Implement the CRDT consistency test involving Client A creation → Sync → Client B verification.
Flow 2 (Budgeting): Implement the Transaction Entry flow, verifying that entries persist after a page reload.

DELIVERABLE:
Provide the full TypeScript implementation including the Page Objects, IPC Utilities, and the Spec files for the two critical flows.
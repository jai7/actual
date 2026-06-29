# Actual Budget — Architecture Reference

## Overview

Actual Budget is a local-first, offline-first personal finance app written in TypeScript/React. The local SQLite database is the source of truth; the sync server is a relay that merges CRDT message logs between devices.

---

## Data Flow

```
React UI → Redux dispatch → send() → IPC/postMessage
  → Backend Worker/Process → Handler → SQLite
    → Sync Engine (CRDT + Merkle) → Sync Server
```

---

## Platform Builds

Two builds share the same `loot-core` backend but differ in process model:

| | Browser/Web | Electron Desktop |
|---|---|---|
| Backend runs in | SharedWorker / Web Worker | `utilityProcess` (separate Node process) |
| IPC mechanism | `Worker.postMessage()` | `ipcRenderer` / `ipcMain` |
| SQLite driver | `absurd-sql` (IndexedDB-backed) | `better-sqlite3` (native file) |
| Preload | `browser-preload/start.ts` | `desktop-electron/preload.ts` via `contextBridge` |

The browser build supports multiple tabs via a **coordinator** (`browser-server/coordinator.ts`): one tab becomes "leader" running the Worker, others route through it.

---

## Message-Passing Protocol

Every UI operation goes through a typed `send()` call.

**Client → Server:**
```typescript
{ id: string, name: string, args?: any, undoTag?: any, catchErrors?: boolean }
```

**Server → Client (reply):**
```typescript
{ type: 'reply', id: string, result?: any, error?: any, mutated: boolean }
```

**Server → Client (push event):**
```typescript
{ type: 'push', name: string, args?: any }
```

The client maintains a `replyHandlers` Map keyed by UUID. Requests are queued until the Worker initializes.

---

## Backend Handler System

Handlers live in `packages/loot-core/src/server/*/app.ts`:

```typescript
app.method('account-update', mutator(undoable(updateAccount)));
```

Key wrappers:
- **`mutator()`** — only one mutating handler runs at a time (prevents concurrent writes)
- **`undoable()`** — snapshots state for undo/redo
- **`catchErrors`** — wraps errors for programmatic API callers

All handlers are typed in `packages/loot-core/src/types/handlers.ts`.

---

## Business Entities

All entities use `tombstone: 0|1` for soft-deletes (required by sync; hard deletes are never used).

### Account
```typescript
{ id, name, offbudget: 0|1, closed: 0|1, sort_order,
  account_id, bank, mask,
  balance_current, balance_available,
  account_sync_source: 'goCardless'|'simpleFin'|'pluggyai'|'enableBanking',
  last_sync, bank_sync_status, tombstone }
```

### Transaction
```typescript
{ id, account, category, payee,
  amount: IntegerAmount,  // stored as integer cents
  date, notes, cleared, reconciled,
  is_parent, is_child, parent_id, subtransactions,  // splits
  transfer_id,   // links the two sides of a transfer
  schedule, imported_id, tombstone }
```

### Category / CategoryGroup
```typescript
CategoryGroup: { id, name, is_income, hidden, tombstone }
Category:      { id, name, group, goal_def, cleanup_def, hidden, tombstone }
```
`goal_def` stores a Peggy DSL string for automated budget templates (e.g. "budget 500", "spend all", "percentage of income").

### Payee
```typescript
{ id, name,
  transfer_acct,      // set when this payee represents a transfer to another account
  favorite, learn_categories, tombstone }
```

### Schedule
```typescript
{ id, name, rule, next_date, completed, posts_transaction,
  _payee, _account, _amount,
  _date: RecurConfig }

RecurConfig: { frequency: 'daily'|'weekly'|'monthly'|'yearly',
               interval, patterns, start, endMode }
```

---

## Query System (AQL)

Client-side builder compiles to SQL via the AQL engine (`server/aql/`):

```typescript
q('transactions')
  .filter({ account: id, tombstone: false })
  .select(['id', 'amount', 'date', 'payee'])
  .orderBy({ date: 'desc' })
  .limit(100)
  .serialize()
// → sent via the 'query' handler → compiled to SQL → run against SQLite
```

---

## Sync Engine

**Files:** `server/sync/index.ts`, `packages/crdt/`

Every mutation appends a message to the `messages` table with a vector clock timestamp.

**Sync flow:**
1. Client computes local Merkle hash tree over messages
2. `POST /sync` sends the tree to the sync server
3. Server diffs trees to find diverged subtrees
4. Only changed messages transmitted (binary protobuf via `@actual-app/crdt`)
5. Changes merged deterministically (CRDT guarantees eventual consistency)

**Sync modes:** `'enabled'` | `'offline'` | `'disabled'` | `'import'`

---

## Server Push Events

| Event | When |
|---|---|
| `sync-event` | Sync start / success / error |
| `cells-changed` | Budget spreadsheet cell updated |
| `backups-updated` | Backup completed |
| `start-load` / `finish-load` | Budget file opened |
| `prefs-updated` | User preferences changed |
| `undo-event` | Undo/redo state changed |

---

## Frontend State (Redux)

Key slices in `desktop-client/src/redux/`:

| Slice | Contents |
|---|---|
| `accountsSlice` | Account list + active account |
| `budgetfilesSlice` | Available budget files |
| `appSlice` | Global loading/error state |
| `prefsSlice` | User preferences |
| `modalsSlice` | Modal/dialog UI state |
| `notificationsSlice` | Toast notifications |

Reads use **TanStack Query** (`aqlQuery()`); mutations go through `send()` + Redux dispatch.

---

## Key User Action Flows

### Creating a Transaction
```
TransactionForm → send('transaction-add', data)
  → mutator(undoable(addTransaction))
  → db.insert('transactions', ...)
  → appends sync message
  → client re-queries via AQL → UI re-renders
```

### Bank Sync
```
User clicks "Sync" → send('gocardless-sync-account', { id, accountId })
  → fetches from GoCardless / SimpleFin / PluggyAI / EnableBanking
  → runs payee matching + auto-categorization rules
  → transactions-batch-update
  → pushes 'sync-event' to client
```

### Budget Assignment
```
User types in budget cell → send('budget/budget-amount', { month, category, amount })
  → updates category_budgets table
  → recalculates dependent spreadsheet cells
  → pushes 'cells-changed' → client updates reactively
```

---

## Key Files

| Concern | Primary File |
|---|---|
| UI entry | `packages/desktop-client/src/index.tsx` |
| Backend entry | `packages/loot-core/src/server/main.ts` |
| Handler types | `packages/loot-core/src/types/handlers.ts` |
| Business entity types | `packages/loot-core/src/types/models/` |
| IPC (browser) | `packages/loot-core/src/platform/client/connection/index.ts` |
| IPC (electron) | `packages/desktop-electron/preload.ts` |
| Database layer | `packages/loot-core/src/server/db/index.ts` |
| Sync engine | `packages/loot-core/src/server/sync/index.ts` |
| Query engine | `packages/loot-core/src/shared/query.ts` |
| Account handlers | `packages/loot-core/src/server/accounts/app.ts` |
| Transaction handlers | `packages/loot-core/src/server/transactions/app.ts` |
| Budget handlers | `packages/loot-core/src/server/budget/app.ts` |

---

## Architecture Diagram

```
┌──────────────────────────────────────────┐
│         desktop-client (React)           │
│  Components → Redux → send() / aqlQuery  │
└──────────────┬───────────────────────────┘
               │ postMessage (Browser) / ipcRenderer (Electron)
┌──────────────▼───────────────────────────┐
│         loot-core backend                │
│  Connection → App Registry → Handlers    │
│  (mutator / undoable / catchErrors)      │
└──────────────┬───────────────────────────┘
               │ SQL
┌──────────────▼───────────────────────────┐
│         SQLite Database                  │
│  accounts, transactions, categories,     │
│  payees, schedules, rules,               │
│  category_budgets, messages (sync log)   │
└──────────────┬───────────────────────────┘
               │ HTTP POST (binary CRDT protobuf)
┌──────────────▼───────────────────────────┐
│  Sync Server (self-hosted or cloud)      │
│  Merkle diff → differential sync        │
└──────────────────────────────────────────┘
```

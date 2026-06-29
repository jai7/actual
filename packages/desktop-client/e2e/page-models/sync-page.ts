import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export class SyncPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get syncButton() {
    return this.page.getByTestId('sync-button');
  }

  async triggerSync() {
    await this.syncButton.click();
    // Wait until no longer in 'syncing' state
    await expect(this.syncButton).not.toHaveAttribute(
      'data-sync-state',
      'syncing',
      { timeout: 15_000 },
    );
  }

  async waitForSuccess() {
    await expect(this.syncButton).toHaveAttribute('data-sync-state', 'ok', {
      timeout: 15_000,
    });
  }

  async waitForError() {
    await expect(this.syncButton).toHaveAttribute('data-sync-state', 'error', {
      timeout: 15_000,
    });
  }

  async getSyncState() {
    return this.syncButton.getAttribute('data-sync-state');
  }
}

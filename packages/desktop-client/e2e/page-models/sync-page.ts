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
    await this.page
      .locator('[data-testid="sync-button"]:not([data-sync-state="syncing"])')
      .waitFor({ timeout: 15_000 });
  }

  async getSyncState() {
    return this.syncButton.getAttribute('data-sync-state');
  }
}

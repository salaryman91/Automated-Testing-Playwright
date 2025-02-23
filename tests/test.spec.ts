import { test, expect, Page } from '@playwright/test';

test.describe('naver access test', () => {
  test.beforeEach(async ({ page }: { page: Page }) => {
    await page.goto('https://www.naver.com');
    await page.waitForSelector('#query');
  });

  test('test_1', async ({ page }: { page: Page }) => {
    const url = page.url();
    expect(url).toContain('naver');
  });

  test('test_2', async ({ page }: { page: Page }) => {
    const url = page.url();
    expect(url).toContain('never');
  });
});
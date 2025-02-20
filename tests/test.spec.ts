import { test, expect, Page } from '@playwright/test';

test.describe('naver access test', () => {
  test.beforeEach(async ({ page }: { page: Page }) => {
    await page.goto('https://www.naver.com');
  });

  test('pass_test', async ({ page }: { page: Page }) => {
    const url = page.url();
    expect(url).toContain('naver');
  });

  test('fail_test', async ({ page }: { page: Page }) => {
    const url = page.url();
    expect(url).toContain('daum');
  });
});

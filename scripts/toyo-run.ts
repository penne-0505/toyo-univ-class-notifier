#!/usr/bin/env node

import {
  collectPortalSnapshot,
  getOrCreatePage,
  gotoPortal,
  isLoginUrl,
  launchStateContext,
  saveSessionState,
  shouldRunHeadless,
} from './lib/toyo';

export async function main(): Promise<void> {
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);

  try {
    await gotoPortal(page);
    if (isLoginUrl(page.url())) {
      throw new Error(
        'Saved session is no longer valid. Run "npm run toyo:login" again to refresh the profile.'
      );
    }

    const artifact = await collectPortalSnapshot(page, 'portal-run');
    await saveSessionState(context, page);

    console.log('Portal run completed.');
    console.log(`Summary: ${artifact.summaryPath}`);
    console.log(`Screenshot: ${artifact.screenshotPath}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

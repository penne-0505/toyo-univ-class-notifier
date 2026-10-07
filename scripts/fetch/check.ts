import {
  getOrCreatePage,
  gotoPortal,
  isLoginUrl,
  launchStateContext,
  paths,
  readSessionMetadata,
  shouldRunHeadless,
} from '../lib/toyo';

export async function main(): Promise<void> {
  const { browser, context } = await launchStateContext({ headless: shouldRunHeadless(true) });
  const page = await getOrCreatePage(context);

  try {
    const metadata = await readSessionMetadata();
    if (metadata) {
      console.log(`Last saved session: ${metadata.savedAt} (${metadata.title})`);
    } else {
      console.log(
        `No saved session metadata yet. Expected after first successful login: ${paths.storageStatePath}`
      );
    }

    await gotoPortal(page);
    if (isLoginUrl(page.url())) {
      console.log(`Session is not authenticated. Login required. Current URL: ${page.url()}`);
      process.exitCode = 2;
      return;
    }

    console.log(`Session is active. Current URL: ${page.url()}`);
    console.log(`Page title: ${await page.title()}`);
  } finally {
    await context.close();
    await browser.close();
  }
}

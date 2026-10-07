import {
  autoFillLogin,
  collectPortalSnapshot,
  getOrCreatePage,
  gotoPortal,
  isLoginUrl,
  launchPersistentBrowser,
  paths,
  saveSessionState,
  shouldRunHeadless,
  waitForSession,
} from '../lib/toyo';

export async function main(): Promise<void> {
  const headless = shouldRunHeadless(false);
  if (!headless && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error(
      'Headed login requires DISPLAY or WAYLAND_DISPLAY. Run this command from your desktop session, or set TOYO_HEADLESS=1 for non-interactive checks.'
    );
  }

  const context = await launchPersistentBrowser({ headless });
  const page = await getOrCreatePage(context);

  try {
    await gotoPortal(page);

    if (isLoginUrl(page.url())) {
      const autoSubmitted = await autoFillLogin(page);
      if (autoSubmitted) {
        console.log(
          'Submitted username/password from environment variables. Waiting for the session to complete...'
        );
      } else {
        console.log(
          `Login window is open. Complete the sign-in flow in the browser using the dedicated profile at: ${paths.profileDir}`
        );
      }
    } else {
      console.log('Existing session looks usable. Refreshing saved auth state...');
    }

    await waitForSession(page, 5 * 60_000);
    await saveSessionState(context, page);
    const artifact = await collectPortalSnapshot(page, 'portal-after-login');

    console.log(`Session saved: ${paths.storageStatePath}`);
    console.log(`Portal summary: ${artifact.summaryPath}`);
    console.log(`Portal screenshot: ${artifact.screenshotPath}`);
  } finally {
    await context.close();
  }
}

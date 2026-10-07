#!/usr/bin/env node

import { main } from './build/academic-schedule';

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

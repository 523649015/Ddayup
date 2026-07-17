import { main } from './verify-browser-flow.mjs';

main({ headless: false }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

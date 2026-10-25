import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The recording scripts' tests run the scripts, which import the built
    // daemon from dist/: build it first when it is missing or older than src/.
    globalSetup: ['tests/global-setup.ts'],
  },
});

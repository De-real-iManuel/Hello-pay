import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      // The SAP SDK's package.json exports map does not expose the deep
      // `./dist/esm/core/connection.js` path, but BountyAgent imports it
      // dynamically (with `as any`) to work around bundler resolution.
      // This alias lets Vitest resolve the path directly to the file on disk.
      "@oobe-protocol-labs/synapse-sap-sdk/dist/esm/core/connection.js": path.resolve(
        "node_modules/@oobe-protocol-labs/synapse-sap-sdk/dist/esm/core/connection.js"
      ),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});

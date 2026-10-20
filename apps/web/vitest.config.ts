import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/** Тесты компонентов — tests/**, в jsdom через @testing-library/react.
 *  Живут вне src, чтобы не попадать в tsc-сборку приложения. */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    restoreMocks: true,
  },
});

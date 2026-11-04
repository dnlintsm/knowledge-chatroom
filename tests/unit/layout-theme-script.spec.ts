import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

test("layout does not use dangerouslySetInnerHTML for theme script", () => {
  const layoutPath = path.resolve(__dirname, "../../src/app/layout.tsx");
  const layoutSource = fs.readFileSync(layoutPath, "utf-8");

  // Ensure dangerouslySetInnerHTML is not used
  expect(layoutSource).not.toContain("dangerouslySetInnerHTML");

  // Ensure the inline script safely handles prefers-color-scheme theme toggle
  expect(layoutSource).toContain("prefers-color-scheme");
  expect(layoutSource).toContain("<script>");
  expect(layoutSource).toContain("</script>");
});

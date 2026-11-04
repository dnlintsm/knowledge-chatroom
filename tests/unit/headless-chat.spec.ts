import { test, expect } from "@playwright/test";
import { v4 as uuidv4 } from "uuid";

test("uuidv4 generates valid RFC 4122 v4 UUIDs for messages and components", () => {
  const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const sampleIds = Array.from({ length: 50 }, () => uuidv4());

  for (const id of sampleIds) {
    expect(id).toMatch(UUID_V4_REGEX);
  }

  // Ensure all generated sample IDs are unique
  const uniqueIds = new Set(sampleIds);
  expect(uniqueIds.size).toBe(50);
});

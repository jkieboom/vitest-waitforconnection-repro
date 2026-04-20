import { expect, test } from "vitest";

test("runs a trivial browser test", () => {
  expect(document.createElement("div") instanceof HTMLDivElement).toBe(true);
});

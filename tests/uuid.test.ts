import { createHash } from "node:crypto";

import { generateObjectId } from "../src/uuid";

test("formats ids as XX plus twenty digest characters plus XX", () => {
  const id = generateObjectId("test-seed", new Set());
  expect(id).toHaveLength(24);
  expect(id).toMatch(/^XX[0-9A-F]{20}XX$/);

  // The digest characters are the first twenty of md5(seed). Pinning the
  // exact mapping keeps generated ids stable across releases, so documents
  // produced by different versions of this library agree.
  const digest = createHash("md5").update("test-seed").digest("hex").toUpperCase();
  expect(id).toBe(`XX${digest.slice(0, 20)}XX`);
});

test("the same seed always produces the same id", () => {
  expect(generateObjectId("same-seed", new Set())).toBe(generateObjectId("same-seed", new Set()));
});

test("colliding ids retry deterministically until free", () => {
  const first = generateObjectId("seed", new Set());
  const second = generateObjectId("seed", new Set([first]));
  const third = generateObjectId("seed", new Set([first, second]));

  expect(second).not.toBe(first);
  expect(third).not.toBe(second);
  // The retry appends spaces to the seed, so the collision chain itself is
  // deterministic and reproducible.
  expect(second).toBe(generateObjectId("seed ", new Set()));
  expect(third).toBe(generateObjectId("seed  ", new Set()));
});

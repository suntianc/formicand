import test from "node:test";
import assert from "node:assert/strict";
import motion from "../desktop/motion.cjs";

test("desktop motion accepts bounded drawings and rejects malformed or ambiguous scenes", () => {
  const ring = {
    id: 1,
    kind: "ring",
    x: 3,
    y: 4,
    size: 8,
    stroke: 1.5,
    duration: 1,
    phase: 0.5,
    color: 0xffffffff,
    accent: 0,
    top: false
  };
  assert.ok(motion.validMotionScene([ring]));
  assert.ok(motion.validMotionScene([]));
  for (const invalid of [
    Array(1),
    [null],
    [ring, ring],
    [{ ...ring, duration: Infinity }],
    [{ ...ring, kind: "file" }],
    [{ ...ring, color: -1 }],
    Array(65).fill(ring)
  ])
    assert.equal(motion.validMotionScene(invalid), false);
});

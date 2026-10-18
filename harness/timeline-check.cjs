/**
 * Unit checks for the timeline fold: DSH session events in, Paseo items out.
 *
 * `plugin-check.cjs` drives a live session, which cannot make a provider fail on
 * demand. The retry row is the one thing there that only a failure produces, so
 * it is asserted here against synthetic events instead.
 *
 * The plugin is TypeScript, so compile it to CommonJS first (same commands as
 * `plugin-check.cjs`), then run this from the build directory:
 *
 *   cd paseo-plugin
 *   npx tsc --noEmit false --outDir .dbg --declaration false \
 *     --module commonjs --moduleResolution node
 *   echo '{"type":"commonjs"}' > .dbg/package.json
 *   cp ../harness/timeline-check.cjs .dbg/
 *   cd .dbg && node timeline-check.cjs
 */
const { TimelineBuilder } = require("./server/timeline.js");

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const attempt = (builder, turn, step) =>
  builder.consume({ type: "assistant/attempt", data: { turn, step, stream: [] } });

const message = (builder, turn, step, text) =>
  builder.consume({
    type: "assistant/message",
    data: { turn, step, message: { role: "assistant", content: [{ type: "text", text }] } },
  });

// A single settled attempt is indistinguishable from a user cancel. Showing it
// would put a scary row under every interrupted turn, which is why this stays [].
{
  const builder = new TimelineBuilder();
  const items = attempt(builder, 1, 1);
  check("one attempt stays silent (cancel must not shout)", items.length === 0, `got ${items.length} item(s)`);
}

// The second attempt for the same step is proof of a retry.
{
  const builder = new TimelineBuilder();
  attempt(builder, 1, 1);
  const items = attempt(builder, 1, 1);
  const row = items.find((item) => item.type === "notification");
  check("second attempt shows a retry row", row !== undefined, JSON.stringify(items));
  check("retry row carries the attempt count", row?.message?.includes("2") === true, row?.message ?? "(none)");
  check("retry row is a warning", row?.level === "warning", row?.level ?? "(none)");
}

// A third attempt updates the same row rather than appending another one.
{
  const builder = new TimelineBuilder();
  attempt(builder, 1, 1);
  attempt(builder, 1, 1);
  const items = attempt(builder, 1, 1);
  const rows = items.filter((item) => item.type === "notification");
  check("third attempt re-emits one row", rows.length === 1, `${rows.length} row(s)`);
  check("row id is stable across attempts", rows[0]?.id === "retry:1:1", rows[0]?.id ?? "(none)");
  check("row reports the latest attempt", rows[0]?.message?.includes("3") === true, rows[0]?.message ?? "(none)");
}

// When the step finally produces a message, the row turns into a recovery note
// instead of claiming it is still retrying.
{
  const builder = new TimelineBuilder();
  attempt(builder, 1, 1);
  attempt(builder, 1, 1);
  const items = message(builder, 1, 1, "done");
  const recovered = items.find((item) => item.id === "retry:1:1");
  check("success after retries rewrites the row", recovered?.type === "notification", JSON.stringify(items));
  check("recovery row is informational", recovered?.level === "info", recovered?.level ?? "(none)");
  check(
    "recovery row states the attempt count",
    recovered?.message?.includes("2") === true,
    recovered?.message ?? "(none)",
  );
  check("assistant text still arrives", items.some((item) => item.type === "assistant_message"), "");
}

// A first-try success must not grow a retry row.
{
  const builder = new TimelineBuilder();
  const items = message(builder, 1, 1, "hi");
  check(
    "success without retries adds no retry row",
    items.every((item) => item.id !== "retry:1:1"),
    JSON.stringify(items),
  );
}

console.log(`\n  ${failures === 0 ? "all timeline checks passed" : `${failures} timeline check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);

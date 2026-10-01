import { expect, it } from "vitest";
import { discoverBlender, runBlender } from "./runtime.js";
it("reports subprocess failures and bounded logs", async () => {
  await expect(
    runBlender(process.execPath, ["-e", 'console.error("fixture failed");process.exit(3)']),
  ).rejects.toThrow("fixture failed");
});
it("terminates a timed-out subprocess", async () => {
  await expect(
    runBlender(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 100 }),
  ).rejects.toThrow("timed out");
});
it("rejects an invalid explicit executable", async () => {
  await expect(discoverBlender({ executable: "/missing/three-blender-test" })).rejects.toThrow(
    "/missing/three-blender-test",
  );
});
it("supports cancellation before and during execution", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => runBlender(process.execPath, [], { signal: controller.signal })).toThrow();
  const active = new AbortController();
  const running = runBlender(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: active.signal,
  });
  active.abort();
  await expect(running).rejects.toThrow("aborted");
});

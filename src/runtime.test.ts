import { spawnSync } from "node:child_process";
import { constants, getPriority, setPriority } from "node:os";
import { expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    getPriority: vi.fn(actual.getPriority),
    setPriority: vi.fn(actual.setPriority),
  };
});
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverBlender, installedBlenders, runBlender } from "./runtime.js";
it("lists official Windows installs newest first", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "fidelity-kit-blender-programfiles-"));
  const x86 = await mkdtemp(path.join(tmpdir(), "fidelity-kit-blender-programfiles-x86-"));
  try {
    for (const name of ["Blender 4.2", "Blender 5.2", "Blender 10.0", "Blender", "Other"])
      await mkdir(path.join(root, "Blender Foundation", name), { recursive: true });
    await mkdir(path.join(x86, "Blender Foundation", "Blender 3.6"), { recursive: true });
    await writeFile(path.join(root, "Blender Foundation", "notes.txt"), "");
    const exe = (base: string, name: string) =>
      path.join(base, "Blender Foundation", name, "blender.exe");
    await expect(
      installedBlenders("win32", { ProgramFiles: root, "ProgramFiles(x86)": x86 }),
    ).resolves.toEqual([
      exe(root, "Blender"),
      exe(root, "Blender 10.0"),
      exe(root, "Blender 5.2"),
      exe(root, "Blender 4.2"),
      exe(x86, "Blender 3.6"),
    ]);
    await expect(
      installedBlenders("win32", { ProgramFiles: root, "ProgramFiles(x86)": root }),
    ).resolves.toHaveLength(4);
    await expect(installedBlenders("win32", {})).resolves.toEqual([]);
    await expect(installedBlenders("linux", { ProgramFiles: root })).resolves.toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(x86, { recursive: true, force: true });
  }
});
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

it("runs children just below normal priority without changing the caller", async () => {
  const before = getPriority();
  const priority = process.platform === "win32" ? constants.priority.PRIORITY_BELOW_NORMAL : 1;
  const output = await runBlender(process.execPath, [
    "-e",
    "setTimeout(() => console.log(require('node:os').getPriority()), 50)",
  ]);
  expect(Number(output.trim())).toBe(Math.max(before, priority));
  expect(getPriority()).toBe(before);
});
it("preserves an already lower inherited priority", () => {
  const runtime = new URL("../dist/runtime.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { constants, setPriority } from 'node:os';
    import { runBlender } from ${JSON.stringify(runtime)};
    setPriority(constants.priority.PRIORITY_LOW);
    console.log(await runBlender(process.execPath, ['-e',
      "setTimeout(() => console.log(require('node:os').getPriority()), 50)"]));
  `,
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  expect(Number(result.stdout.trim())).toBe(constants.priority.PRIORITY_LOW);
});
it("continues rendering when priority adjustment is denied", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(getPriority).mockReturnValueOnce(0);
  vi.mocked(setPriority).mockImplementationOnce(() => {
    throw new Error("priority denied");
  });
  try {
    await expect(
      runBlender(process.execPath, ["-e", "console.log('render complete')"]),
    ).resolves.toContain("render complete");
    expect(warning).toHaveBeenCalledWith(
      "Unable to lower Blender CPU priority:",
      expect.any(Error),
    );
  } finally {
    warning.mockRestore();
  }
});

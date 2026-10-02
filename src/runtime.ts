import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { constants, getPriority, setPriority } from "node:os";

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onLog?: (line: string) => void;
}
/** Runs without a shell, bounds retained output, and terminates the process group on cancellation. */
export function runBlender(
  executable: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.once("spawn", () => {
      try {
        // Yield to normal-priority work without raising an already lower inherited priority.
        const priority =
          process.platform === "win32" ? constants.priority.PRIORITY_BELOW_NORMAL : 1;
        if (getPriority(child.pid!) < priority) setPriority(child.pid!, priority);
      } catch (error) {
        // A short-lived child may have exited before we can adjust its priority.
        if (
          (error as NodeJS.ErrnoException & { info?: { code?: string } }).info?.code !== "ESRCH" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        ) {
          console.warn("Unable to lower Blender CPU priority:", error);
        }
      }
    });
    let output = "";
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else if (child.pid) process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error as Error;
      }
    };
    const stop = (error: Error) => {
      failure ??= error;
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const abort = () =>
      stop(new Error("Blender render aborted", { cause: options.signal?.reason }));
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("Blender process timed out")),
      options.timeoutMs ?? 30 * 60_000,
    );
    if (options.signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.on("data", (chunk: Buffer) => {
        const message = chunk.toString();
        output = (output + message).slice(-16000);
        pending += message;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!.slice(-16000);
        for (const line of lines) {
          try {
            options.onLog?.(line);
          } catch (error) {
            stop(error as Error);
          }
        }
      });
    }
    child.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      kill("SIGKILL");
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Blender exited with ${signal ?? code}:\n${output}`));
      else resolve(output);
    });
  });
}

export interface BlenderRuntime {
  executable: string;
  version: string;
}
/** Unversioned names first, then newest version first. */
const newestFirst = (unversioned: string) => (a: string, b: string) =>
  a === unversioned ? -1 : b === unversioned ? 1 : b.localeCompare(a, undefined, { numeric: true });

/**
 * Executables in standard install locations: macOS Applications bundles, and on Windows the official
 * installer's `Blender Foundation\Blender <version>` directories (Microsoft Store builds can't run headless).
 * Directories without an executable are kept; probing them fails and discovery moves on.
 */
export async function installedBlenders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const found: string[] = [];
  if (platform === "darwin") {
    for (const directory of ["/Applications", path.join(env.HOME ?? "", "Applications")]) {
      const entries = await readdir(directory).catch(() => [] as string[]);
      found.push(
        ...entries
          .filter((name) => /^Blender(?:\s+.*)?\.app$/.test(name))
          .sort(newestFirst("Blender.app"))
          .map((name) => path.join(directory, name, "Contents/MacOS/Blender")),
      );
    }
  } else if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
      (root): root is string => !!root,
    );
    for (const root of new Set(roots)) {
      const directory = path.join(root, "Blender Foundation");
      const entries = await readdir(directory).catch(() => [] as string[]);
      found.push(
        ...entries
          .filter((name) => /^Blender(?:\s+.*)?$/.test(name))
          .sort(newestFirst("Blender"))
          .map((name) => path.join(directory, name, "blender.exe")),
      );
    }
  }
  return found;
}

/** Explicit overrides are authoritative: an invalid override fails instead of silently selecting another install. */
export async function discoverBlender(
  options: { executable?: string; candidates?: string[] } = {},
): Promise<BlenderRuntime> {
  const explicit = options.executable ?? process.env.BLENDER_EXECUTABLE?.trim();
  const installed = explicit ? [] : await installedBlenders();
  const candidates = explicit
    ? [explicit]
    : ["blender", ...installed, ...(options.candidates ?? [])];
  const failures: string[] = [];
  for (const executable of new Set(candidates)) {
    try {
      const output = await runBlender(executable, ["--version"], { timeoutMs: 5000 });
      const match = output.match(/Blender (\d+)\.(\d+)\.(\d+)/);
      if (!match || Number(match[1]) < 4) throw new Error("Blender 4.0+ is required");
      return { executable, version: `${match[1]}.${match[2]}.${match[3]}` };
    } catch (error) {
      failures.push(`${executable}: ${(error as Error).message}`);
    }
  }
  throw new Error(
    `Unable to locate supported Blender. Set executable or BLENDER_EXECUTABLE.\n${failures.join("\n")}`,
  );
}

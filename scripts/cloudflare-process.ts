// ABOUTME: Runs one Cloudflare child process with bounded output and signal forwarding.
// ABOUTME: Lets parent cleanup handlers run immediately when a command is interrupted.
import { spawn } from "node:child_process";

type ProcessOptions = Readonly<{
  captureOutput?: boolean;
  classifyFailure?: (errorOutput: string) => Error | undefined;
  cwd: string;
  environment: Record<string, string | undefined>;
}>;

const maximumCapturedOutputBytes = 10 * 1024 * 1024;
let interruptedSignal: "SIGINT" | "SIGTERM" | undefined;

export function recordCloudflareInterruption(
  signal: "SIGINT" | "SIGTERM",
) {
  interruptedSignal ??= signal;
  process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;
}

export function assertCloudflareNotInterrupted() {
  if (interruptedSignal) {
    throw new Error(`Cloudflare operation was interrupted by ${interruptedSignal}.`);
  }
}

export function registerArtifactCleanup(cleanup: () => void) {
  let active = true;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const handle = (signal: "SIGINT" | "SIGTERM") => {
    if (!active) return;
    recordCloudflareInterruption(signal);
    if (cleanupTimer) return;
    cleanupTimer = setTimeout(() => {
      if (!active) return;
      active = false;
      cleanup();
    }, 1_500);
  };
  const interrupt = () => handle("SIGINT");
  const terminate = () => handle("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  return () => {
    active = false;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
}

export function runCloudflareProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
) {
  assertCloudflareNotInterrupted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.environment as NodeJS.ProcessEnv,
      stdio: options.captureOutput
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    const output: Buffer[] = [];
    const errorOutput: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let interrupted = false;
    let closeStatus: number | null | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let windowsTerminationPending = false;
    const childPid = child.pid;

    const capture = (chunk: Buffer, retain: boolean) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maximumCapturedOutputBytes) {
        killTree("SIGKILL");
        return false;
      }
      if (retain) output.push(chunk);
      return true;
    };
    if (options.captureOutput) {
      child.stdout?.on("data", (chunk: Buffer) => capture(chunk, true));
      child.stderr?.on("data", (chunk: Buffer) => {
        if (capture(chunk, false) && options.classifyFailure) {
          errorOutput.push(chunk);
        }
      });
    }

    const killTree = (signal: "SIGINT" | "SIGTERM" | "SIGKILL") => {
      if (!childPid) return;
      if (process.platform === "win32") {
        if (windowsTerminationPending) return;
        windowsTerminationPending = true;
        const killer = spawn(
          "taskkill",
          ["/PID", String(childPid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("close", () => {
          windowsTerminationPending = false;
          finishInterruptedProcess();
        });
        killer.once("error", () => {
          windowsTerminationPending = false;
          child.kill(signal);
          finishInterruptedProcess();
        });
        return;
      }
      try {
        process.kill(-childPid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const processTreeIsRunning = () => {
      if (!childPid) return false;
      if (process.platform === "win32") {
        return windowsTerminationPending || child.exitCode === null;
      }
      try {
        process.kill(-childPid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const finish = () => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      if (killTimer) clearTimeout(killTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
    };
    const settleForStatus = (status: number | null) => {
      if (settled) return;
      settled = true;
      finish();
      if (outputBytes > maximumCapturedOutputBytes) {
        reject(new Error(`${command} exceeded the captured output limit.`));
      } else if (interrupted) {
        reject(new Error(`${command} was interrupted.`));
      } else if (status !== 0) {
        const classifiedFailure = options.classifyFailure?.(
          Buffer.concat([...output, ...errorOutput]).toString("utf8"),
        );
        reject(
          classifiedFailure ??
            new Error(`${command} exited with status ${status ?? "unknown"}.`),
        );
      } else {
        resolve(Buffer.concat(output).toString("utf8"));
      }
    };
    const finishInterruptedProcess = () => {
      if (settled || closeStatus === undefined) return;
      if (processTreeIsRunning()) {
        shutdownTimer = setTimeout(finishInterruptedProcess, 25);
        return;
      }
      settleForStatus(closeStatus);
    };
    const forward = (signal: "SIGINT" | "SIGTERM") => {
      if (interrupted) {
        killTree("SIGKILL");
        finishInterruptedProcess();
        return;
      }
      interrupted = true;
      recordCloudflareInterruption(signal);
      killTree(signal);
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
        finishInterruptedProcess();
      }, 1_000);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.prependListener("SIGINT", interrupt);
    process.prependListener("SIGTERM", terminate);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      closeStatus = status;
      if (interrupted) {
        finishInterruptedProcess();
        return;
      }
      settleForStatus(status);
    });
  });
}

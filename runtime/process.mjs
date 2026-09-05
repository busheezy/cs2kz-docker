import { spawn } from "node:child_process";

export function run(command, args, { signal, timeout = 0, ...options } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", detached: true, ...options });
    let failure;
    const terminate = () => {
      failure = new Error(`${command} was interrupted or timed out`);
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            reject(error);
          }
        }
      }
    };
    const timer = timeout ? setTimeout(terminate, timeout) : null;
    signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", terminate);
      if (failure || code !== 0) {
        reject(failure || new Error(`${command} exited with ${code ?? exitSignal}`));
        return;
      }
      resolve();
    });
  });
}

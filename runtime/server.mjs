import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { install } from "./install.mjs";
import { PTERODACTYL, SERVER, SOCKET } from "./paths.mjs";
import { readSettings } from "./settings.mjs";

export async function serve() {
  const abort = new AbortController();
  let settings = readSettings();
  let child;
  let exited;
  let maintenanceAt;
  let updateAt;
  let restarting = false;
  let failure;
  const shutdown = () => abort.abort();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  function command(value) {
    if (!child || child.exitCode !== null || child.signalCode || child.stdin.destroyed) {
      throw new Error("Server is not running");
    }
    if (typeof value !== "string" || !value || /[\r\n\0]/.test(value)) {
      throw new Error("Send one console command at a time");
    }
    child.stdin.write(value + "\n");
  }
  function start() {
    const game = settings.game;
    const args = [
      "-dedicated",
      "-console",
      "-usercon",
      "-port",
      String(game.port),
      "-maxplayers",
      String(game.maxplayers),
      "+exec",
      "server-private.cfg",
      "+exec",
      "server.cfg",
    ];
    args.push(
      ...(game.workshop_map ? ["+host_workshop_map", game.workshop_map] : ["+map", game.map]),
      ...game.extra_args,
    );
    child = spawn("./cs2.sh", args, {
      cwd: path.join(SERVER, "game"),
      detached: true,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.on("error", () => {});
    exited = new Promise((resolve) => {
      child.once("error", (error) => {
        failure = error;
        resolve();
      });
      child.once("close", resolve);
    });
    maintenanceAt = settings.maintenance.interval_hours
      ? Date.now() + settings.maintenance.interval_hours * 3600000
      : null;
    updateAt = null;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) {
      return;
    }
    try {
      command("quit");
    } catch {}
    for (const [seconds, signal] of [
      [45, "SIGTERM"],
      [10, "SIGKILL"],
    ]) {
      const done = await Promise.race([
        exited.then(() => true),
        delay(seconds * 1000, false, { ref: false }),
      ]);
      if (done) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
    await exited;
  }
  function request(payload) {
    if (payload.action === "status") {
      return {
        running: Boolean(child && child.exitCode === null && !child.signalCode && !failure),
        maintenance_in_seconds: maintenanceAt
          ? Math.max(0, Math.floor((maintenanceAt - Date.now()) / 1000))
          : null,
      };
    }
    if (payload.action === "command") {
      command(payload.command);
      return "Command sent; output is in server logs";
    }
    if (payload.action === "update") {
      maintenanceAt = Date.now();
      return "Maintenance queued; configured warning period applies";
    }
    if (payload.action === "restart") {
      restarting = true;
      return "Restart queued; use update to apply component/configuration changes";
    }
    throw new Error("Unknown action");
  }
  const connections = new Set();
  const listener = net.createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(3000, () => socket.destroy());
    let data = "";
    socket.on("data", (block) => {
      data += block.toString();
      if (Buffer.byteLength(data) > 16384) {
        socket.destroy();
        return;
      }
      if (!data.includes("\n")) {
        return;
      }
      socket.removeAllListeners("data");
      try {
        socket.end(
          JSON.stringify({ ok: true, result: request(JSON.parse(data.split("\n")[0])) }) + "\n",
        );
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
      }
    });
  });
  let consoleBuffer = "";
  function consoleInput(block) {
    consoleBuffer += block.toString();
    if (Buffer.byteLength(consoleBuffer) > 16384) {
      consoleBuffer = "";
      console.error("Console input exceeded 16 KiB");
      return;
    }
    while (consoleBuffer.includes("\n")) {
      const index = consoleBuffer.indexOf("\n");
      const line = consoleBuffer.slice(0, index).trim();
      consoleBuffer = consoleBuffer.slice(index + 1);
      if (!line) {
        continue;
      }
      if (line === "quit") {
        shutdown();
        return;
      }
      try {
        if (line === "cs2kz_update") {
          console.log(request({ action: "update" }));
          continue;
        }
        command(line);
      } catch (error) {
        console.error(error.message);
      }
    }
  }
  try {
    await install(settings, abort.signal);
    abort.signal.throwIfAborted();
    mkdirSync(path.dirname(SOCKET), { recursive: true });
    rmSync(SOCKET, { force: true });
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(SOCKET, resolve);
    });
    listener.on("error", (error) => {
      failure = error;
    });
    chmodSync(SOCKET, 0o600);
    start();
    if (PTERODACTYL) {
      process.stdin.on("data", consoleInput);
    }
    while (!abort.signal.aborted) {
      if (failure) {
        throw failure;
      }
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`Game process exited: ${child.exitCode ?? child.signalCode}`);
      }
      if (maintenanceAt && Date.now() >= maintenanceAt && updateAt === null) {
        const warning = readSettings().maintenance.warning_seconds;
        command(`say Server maintenance in ${warning} seconds`);
        updateAt = Date.now() + warning * 1000;
      }
      const updating = updateAt !== null && Date.now() >= updateAt;
      if (updating || restarting) {
        restarting = false;
        await stop();
        abort.signal.throwIfAborted();
        settings = readSettings();
        if (updating) {
          await install(settings, abort.signal);
        }
        abort.signal.throwIfAborted();
        start();
      }
      await delay(250, undefined, { signal: abort.signal });
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      throw error;
    }
  } finally {
    process.stdin.removeListener("data", consoleInput);
    process.stdin.pause();
    for (const socket of connections) {
      socket.destroy();
    }
    listener.close();
    await stop();
    rmSync(SOCKET, { force: true });
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
  }
}

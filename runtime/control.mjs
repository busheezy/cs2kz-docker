import net from "node:net";
import dgram from "node:dgram";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { STATE, SOCKET } from "./paths.mjs";
import { installedBuild } from "./install.mjs";
import { COMPONENTS, readSettings } from "./settings.mjs";

export function versions() {
  const components = {};
  for (const name of Object.keys(COMPONENTS)) {
    const file = path.join(STATE, `${name}.json`);
    if (!existsSync(file)) {
      continue;
    }
    const { resolved, download_sha256 } = JSON.parse(readFileSync(file, "utf8"));
    components[name] = { resolved, download_sha256 };
  }
  return { build: installedBuild(), components };
}

export function freeze() {
  const settings = readSettings();
  const installed = versions();
  settings.game.update = false;
  settings.maintenance.interval_hours = 0;
  settings.game.expected_build = installed.build;
  for (const [name, config] of Object.entries(settings.components)) {
    if (config.version === "off") {
      continue;
    }
    const record = installed.components[name];
    if (!record) {
      throw new Error(`No installed version for ${name}`);
    }
    config.version =
      name === "metamod"
        ? record.resolved.replace(/^mmsource-/, "").replace(/-linux\.tar\.gz$/, "")
        : record.resolved;
    config.sha256 = record.download_sha256;
  }
  return settings;
}

export async function control(action, command) {
  const result = await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let data = "";
    socket.on("error", reject);
    socket.setTimeout(10000, () => socket.destroy(new Error("Control request timed out")));
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ action: action === "health" ? "status" : action, command }) + "\n",
      ),
    );
    socket.on("data", (block) => {
      data += block.toString();
      if (data.length > 65536) {
        socket.destroy(new Error("Invalid control response"));
        return;
      }
      if (!data.includes("\n")) {
        return;
      }
      try {
        const response = JSON.parse(data.split("\n")[0]);
        if (!response.ok) {
          throw new Error(response.error);
        }
        resolve(response.result);
        socket.destroy();
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.on("end", () => reject(new Error("Control socket closed without a response")));
  });
  if (action !== "health") {
    return result;
  }
  if (!result.running) {
    throw new Error("Game is not running");
  }
  await new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("A2S query timed out"));
    }, 3000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.on("message", (packet) => {
      clearTimeout(timer);
      socket.close();
      if (
        packet.length >= 5 &&
        packet.readUInt32LE(0) === 0xffffffff &&
        [0x49, 0x41].includes(packet[4])
      ) {
        resolve();
        return;
      }
      reject(new Error("Game did not answer an A2S query"));
    });
    socket.send(
      Buffer.from("ffffffff54536f7572636520456e67696e6520517565727900", "hex"),
      readSettings().game.port,
      "127.0.0.1",
    );
  });
}

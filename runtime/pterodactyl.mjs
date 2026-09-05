import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CONFIG, SERVER, STATE, STEAMCMD } from "./paths.mjs";
import { readSettings } from "./settings.mjs";
import { install } from "./install.mjs";

export async function pterodactyl(installOnly) {
  for (const directory of [SERVER, STATE, CONFIG, STEAMCMD]) {
    mkdirSync(directory, { recursive: true });
  }
  const marker = path.join(STEAMCMD, ".bootstrap-ready");
  if (!existsSync(marker)) {
    cpSync("/opt/steamcmd", STEAMCMD, { recursive: true });
    writeFileSync(marker, "");
  }
  for (const filename of ["settings.json", "server.cfg"]) {
    const destination = path.join(CONFIG, filename);
    if (!existsSync(destination)) {
      copyFileSync(path.join("/opt/cs2kz/defaults", filename), destination);
    }
  }
  const privateFile = path.join(CONFIG, "server-private.cfg");
  let content = existsSync(privateFile)
    ? readFileSync(privateFile, "utf8")
    : `sv_setsteamaccount ""\nrcon_password "${randomBytes(24).toString("hex")}"\n`;
  for (const [variable, command] of [
    ["GSLT", "sv_setsteamaccount"],
    ["RCON_PASSWORD", "rcon_password"],
  ]) {
    const value = process.env[variable];
    if (!value) {
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error(`${variable} must contain only letters, digits, underscores or hyphens`);
    }
    const pattern = new RegExp(`^\\s*${command}\\b[^\\n]*$`, "gm");
    const line = `${command} "${value}"`;
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : content + "\n" + line + "\n";
  }
  writeFileSync(privateFile, content);
  chmodSync(privateFile, 0o600);
  const settings = readSettings();
  if (installOnly) {
    await install(settings);
    return;
  }
  const startup = (process.env.STARTUP ?? "cs2kz start").replace(/\{\{([A-Z0-9_]+)\}\}/g, "${$1}");
  if (!startup.trim()) {
    throw new Error("STARTUP must specify an executable");
  }
  process.chdir(SERVER);
  process.execve("/bin/bash", ["/bin/bash", "-c", startup], process.env);
}

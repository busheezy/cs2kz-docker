import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CONFIG, GAME, SERVER, STATE, STEAMCMD } from "./paths.mjs";
import { COMPONENTS } from "./settings.mjs";
import { safePath, unpack } from "./archive.mjs";
import { run } from "./process.mjs";

async function download(url, destination, signal) {
  if (new URL(url).protocol !== "https:") {
    throw new Error("Downloads require HTTPS");
  }
  await run(
    "curl",
    [
      "--fail",
      "--location",
      "--retry",
      "5",
      "--connect-timeout",
      "30",
      "--max-time",
      "600",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--silent",
      "--show-error",
      "--output",
      destination,
      url,
    ],
    { signal },
  );
}

async function release(name, version, signal) {
  if (name === "metamod") {
    const base = "https://www.metamodsource.net/mmsdrop/2.0/";
    let filename = `mmsource-${version}-linux.tar.gz`;
    if (version === "latest") {
      const staging = mkdtempSync(path.join(os.tmpdir(), "metamod-"));
      try {
        const pointer = path.join(staging, "latest");
        await download(base + "mmsource-latest-linux", pointer, signal);
        filename = readFileSync(pointer, "utf8").trim();
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    if (!/^mmsource-2\.0\.\d+-git\d+-linux\.tar\.gz$/.test(filename)) {
      throw new Error(`Unexpected Metamod filename: ${filename}`);
    }
    return { resolved: filename, url: base + filename };
  }
  const endpoint = version === "latest" ? "latest" : `tags/${encodeURIComponent(version)}`;
  const headers = { "User-Agent": "cs2kz-docker" };
  const tokenFile = "/run/secrets/github_token";
  if (existsSync(tokenFile)) {
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  const signals = [AbortSignal.timeout(30000)];
  if (signal) {
    signals.push(signal);
  }
  const response = await fetch(
    `https://api.github.com/repos/${COMPONENTS[name]}/releases/${endpoint}`,
    { headers, redirect: "error", signal: AbortSignal.any(signals) },
  );
  if (!response.ok) {
    throw new Error(`Release lookup for ${name} failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const assets = data.assets.filter(
    (asset) =>
      /linux|steamrt3/i.test(asset.name) &&
      !/upgrade|steamrt4/i.test(asset.name) &&
      /\.(tar\.gz|zip)$/.test(asset.name),
  );
  if (assets.length !== 1) {
    throw new Error(`Expected one Linux/Sniper archive for ${name}`);
  }
  return { resolved: data.tag_name, url: assets[0].browser_download_url };
}

export async function installComponent(name, config, signal) {
  mkdirSync(STATE, { recursive: true });
  mkdirSync(GAME, { recursive: true });
  const manifest = path.join(STATE, `${name}.json`);
  const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  if (config.version === "off") {
    for (const relative of previous.files || []) {
      if (/\.(so|vdf)$/.test(relative)) {
        rmSync(safePath(GAME, relative), { force: true });
      }
    }
    rmSync(manifest, { force: true });
    return;
  }
  let installed = previous.resolved || "";
  if (name === "metamod") {
    installed = installed.replace(/^mmsource-/, "").replace(/-linux\.tar\.gz$/, "");
  }
  const intact = (previous.files || []).every((file) => existsSync(safePath(GAME, file)));
  const checksumMatches =
    !config.sha256 || previous.download_sha256 === config.sha256.toLowerCase();
  if (config.version !== "latest" && installed === config.version && intact && checksumMatches) {
    return;
  }
  const { resolved, url } = await release(name, config.version, signal);
  if (previous.resolved === resolved && intact && checksumMatches) {
    return;
  }
  const staging = mkdtempSync(path.join(STATE, "install-"));
  try {
    const archive = path.join(staging, "download");
    await download(url, archive, signal);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (config.sha256 && digest !== config.sha256.toLowerCase()) {
      throw new Error(`SHA256 mismatch for ${name}`);
    }
    const payload = path.join(staging, "payload");
    mkdirSync(payload);
    await unpack(archive, payload, url.endsWith(".zip"));
    const files = readdirSync(payload, { recursive: true, withFileTypes: true });
    const regular = files.filter((file) => file.isFile());
    if (!regular.length) {
      throw new Error(`Empty archive for ${name}`);
    }
    for (const file of regular) {
      const relative = path.relative(payload, path.join(file.parentPath, file.name));
      if (!/^(addons|cfg)\//.test(relative)) {
        throw new Error(`Unexpected archive layout for ${name}`);
      }
      safePath(GAME, relative);
    }
    const managed = [];
    for (const file of regular) {
      const source = path.join(file.parentPath, file.name);
      const relative = path.relative(payload, source);
      const destination = safePath(GAME, relative);
      if (relative.startsWith("cfg/") && existsSync(destination)) {
        continue;
      }
      mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = safePath(GAME, relative + ".installing");
      rmSync(temporary, { force: true });
      copyFileSync(source, temporary);
      chmodSync(temporary, statSync(source).mode & 0o111 ? 0o755 : 0o644);
      renameSync(temporary, destination);
      if (!relative.startsWith("cfg/")) {
        managed.push(relative);
      }
    }
    for (const relative of previous.files || []) {
      if (!managed.includes(relative) && /\.(so|vdf)$/.test(relative)) {
        rmSync(safePath(GAME, relative), { force: true });
      }
    }
    const record = {
      requested: config.version,
      resolved,
      sha256: config.sha256 || "",
      download_sha256: digest,
      url,
      files: managed,
    };
    writeFileSync(manifest + ".tmp", JSON.stringify(record, null, 2) + "\n");
    renameSync(manifest + ".tmp", manifest);
    console.log(`Installed ${name} ${resolved}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function updateGame(game, signal) {
  const binary = path.join(SERVER, "game/bin/linuxsteamrt64/cs2");
  if (game.expected_build && !existsSync(binary)) {
    throw new Error("Restore the pinned CS2 installation before starting");
  }
  if (game.update || !existsSync(binary)) {
    const args = [
      "+force_install_dir",
      SERVER,
      "+login",
      "anonymous",
      "+app_update",
      "730",
      "-beta",
      game.branch,
    ];
    if (game.validate) {
      args.push("validate");
    }
    args.push("+quit");
    let backup;
    const cfg = path.join(GAME, "cfg");
    if (existsSync(cfg)) {
      const backups = path.join(STATE, "config-backups");
      mkdirSync(backups, { recursive: true });
      backup = path.join(backups, `${Date.now()}`);
      cpSync(cfg, backup, { recursive: true, verbatimSymlinks: true });
      for (const old of readdirSync(backups).sort().slice(0, -5)) {
        rmSync(path.join(backups, old), { recursive: true, force: true });
      }
    }
    try {
      await run(path.join(STEAMCMD, "steamcmd.sh"), args, { signal, timeout: 14400000 });
    } finally {
      if (backup) {
        cpSync(backup, cfg, { recursive: true, verbatimSymlinks: true });
      }
    }
  }
  if (!existsSync(binary)) {
    throw new Error("SteamCMD did not install the CS2 executable");
  }
  if (game.expected_build && installedBuild() !== game.expected_build) {
    throw new Error("Installed CS2 build does not match expected_build");
  }
  const steamClient = path.join(STEAMCMD, "linux64/steamclient.so");
  if (!existsSync(steamClient)) {
    await run(path.join(STEAMCMD, "steamcmd.sh"), ["+quit"], { signal, timeout: 900000 });
  }
  const sdk = path.join(os.homedir(), ".steam/sdk64");
  mkdirSync(sdk, { recursive: true });
  const library = path.join(sdk, "steamclient.so");
  if (!existsSync(library)) {
    rmSync(library, { force: true });
    symlinkSync(path.relative(sdk, steamClient), library);
  }
}

export function installedBuild() {
  const manifest = readFileSync(path.join(SERVER, "steamapps/appmanifest_730.acf"), "utf8");
  const match = manifest.match(/"buildid"\s+"(\d+)"/);
  if (!match) {
    throw new Error("Cannot find installed Steam build");
  }
  return match[1];
}

export async function install(settings, signal) {
  mkdirSync(STATE, { recursive: true });
  await updateGame(settings.game, signal);
  for (const [name, config] of Object.entries(settings.components)) {
    signal?.throwIfAborted();
    await installComponent(name, config, signal);
  }
  const gameinfo = path.join(GAME, "gameinfo.gi");
  let content = readFileSync(gameinfo, "utf8");
  if (!/^\s*Game\s+csgo\/addons\/metamod\s*$/m.test(content)) {
    if (!/SearchPaths\s*\{/.test(content)) {
      throw new Error("Cannot locate SearchPaths in gameinfo.gi");
    }
    content = content.replace(/(SearchPaths\s*\{)/, "$1\n\t\t\tGame csgo/addons/metamod");
    writeFileSync(gameinfo, content);
  }
  for (const filename of ["server.cfg", "server-private.cfg", "cs2kz-server-config.txt"]) {
    const source = path.join(CONFIG, filename);
    if (filename === "cs2kz-server-config.txt" && !existsSync(source)) {
      continue;
    }
    const destination = safePath(GAME, `cfg/${filename}`);
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

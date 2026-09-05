import { readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG, PTERODACTYL } from "./paths.mjs";

export const COMPONENTS = {
  metamod: null,
  cs2kz: "KZGlobalTeam/cs2kz-metamod",
  sql_mm: "zer0k-z/sql_mm",
  multiaddonmanager: "Source2ZE/MultiAddonManager",
  cs2menus: "FemboyKZ/mm-cs2menus",
};

export function readSettings(file = path.join(CONFIG, "settings.json")) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (PTERODACTYL) {
    applyPanelSettings(data);
  }
  const game = data.game;
  if (typeof game.update !== "boolean" || typeof game.validate !== "boolean") {
    throw new Error("game.update and game.validate must be booleans");
  }
  for (const [section, key, low, high] of [
    ["game", "port", 1024, 65535],
    ["game", "maxplayers", 1, 64],
    ["maintenance", "interval_hours", 0, 8760],
    ["maintenance", "warning_seconds", 0, 3600],
  ]) {
    const value = data[section][key];
    if (!Number.isInteger(value) || value < low || value > high) {
      throw new Error(`Invalid ${section}.${key}`);
    }
  }
  for (const key of ["map", "branch"]) {
    if (typeof game[key] !== "string" || !/^[A-Za-z0-9_./-]+$/.test(game[key])) {
      throw new Error(`Invalid game.${key}`);
    }
  }
  for (const key of ["workshop_map", "expected_build"]) {
    if (typeof game[key] !== "string" || !/^[0-9]*$/.test(game[key])) {
      throw new Error(`Invalid game.${key}`);
    }
  }
  if (game.update && game.expected_build) {
    throw new Error("expected_build requires update=false; restore a matching installation first");
  }
  if (
    !Array.isArray(game.extra_args) ||
    !game.extra_args.every((arg) => typeof arg === "string" && !/[\r\n\0]/.test(arg))
  ) {
    throw new Error("extra_args must be an array of strings without line breaks");
  }
  if (Object.keys(data.components).sort().join() !== Object.keys(COMPONENTS).sort().join()) {
    throw new Error("Configure exactly the five supported components");
  }
  for (const [name, component] of Object.entries(data.components)) {
    if (typeof component.version !== "string" || !/^[A-Za-z0-9_.-]+$/.test(component.version)) {
      throw new Error(`Invalid version for ${name}`);
    }
    if (component.version === "off" && ["metamod", "cs2kz"].includes(name)) {
      throw new Error(`${name} is required`);
    }
    const digest = component.sha256 || "";
    if (typeof digest !== "string" || (digest && !/^[a-fA-F0-9]{64}$/.test(digest))) {
      throw new Error(`Invalid SHA256 for ${name}`);
    }
    if (digest && ["latest", "off"].includes(component.version)) {
      throw new Error("SHA256 requires a fixed version");
    }
  }
  return data;
}

function applyPanelSettings(data) {
  const fields = {
    SERVER_PORT: ["game", "port", Number],
    CS2_BRANCH: ["game", "branch", String],
    CS2_EXPECTED_BUILD: ["game", "expected_build", String],
    CS2_MAP: ["game", "map", String],
    CS2_WORKSHOP_MAP: ["game", "workshop_map", String],
    CS2_MAXPLAYERS: ["game", "maxplayers", Number],
    MAINTENANCE_HOURS: ["maintenance", "interval_hours", Number],
    MAINTENANCE_WARNING: ["maintenance", "warning_seconds", Number],
  };
  for (const [variable, [section, key, convert]] of Object.entries(fields)) {
    if (process.env[variable]) {
      data[section][key] = convert(process.env[variable]);
    }
  }
  for (const [variable, key] of [
    ["CS2_UPDATE", "update"],
    ["CS2_VALIDATE", "validate"],
  ]) {
    const value = process.env[variable];
    if (!value) {
      continue;
    }
    if (!["0", "1"].includes(value)) {
      throw new Error(`${variable} must be 0 or 1`);
    }
    data.game[key] = value === "1";
  }
  for (const name of Object.keys(COMPONENTS)) {
    for (const [suffix, key] of [
      ["VERSION", "version"],
      ["SHA256", "sha256"],
    ]) {
      const value = process.env[`${name.toUpperCase()}_${suffix}`];
      if (value) {
        data.components[name][key] = value;
      }
    }
  }
}

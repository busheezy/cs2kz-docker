import path from "node:path";

export const SERVER = path.resolve(process.env.SERVER_DIR || "/server");
export const GAME = path.join(SERVER, "game/csgo");
export const STATE = path.resolve(process.env.STATE_DIR || "/state");
export const CONFIG = path.resolve(process.env.CONFIG_DIR || "/config");
export const STEAMCMD = path.resolve(process.env.STEAMCMD_DIR || "/opt/steamcmd");
export const SOCKET = process.env.CONTROL_SOCKET || "/run/cs2kz/control.sock";
export const PTERODACTYL = process.env.PTERODACTYL === "1";

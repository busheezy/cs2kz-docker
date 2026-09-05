import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { serve } from "./server.mjs";
import { control, freeze, versions } from "./control.mjs";
import { install } from "./install.mjs";
import { pterodactyl } from "./pterodactyl.mjs";
import { readSettings } from "./settings.mjs";

process.umask(0o077);
try {
  const [action = "status", ...args] = process.argv.slice(2);
  let result;
  if (action === "start") {
    await serve();
  } else if (action === "install") {
    await install(readSettings());
  } else if (action === "pterodactyl") {
    await pterodactyl(args.includes("--install"));
  } else if (action === "versions") {
    result = versions();
  } else if (action === "freeze") {
    result = freeze();
  } else if (action === "egg") {
    const { values } = parseArgs({
      args,
      options: { image: { type: "string" }, author: { type: "string" } },
    });
    if (!values.image || !values.author) {
      throw new Error("Usage: cs2kz egg --image REGISTRY/IMAGE:TAG --author EMAIL");
    }
    const egg = JSON.parse(readFileSync(new URL("./egg-cs2kz.json", import.meta.url), "utf8"));
    egg.author = values.author;
    egg.docker_images = { "CS2KZ Sniper": values.image };
    egg.scripts.installation.container = values.image;
    result = egg;
  } else {
    result = await control(action, args.join(" "));
  }
  if (result !== undefined) {
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

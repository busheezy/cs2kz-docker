# Pterodactyl / Wings

The game server uses **one Dockerfile** with a shared `runtime` stage and two final targets:

| Target                 | Purpose                           | Persistent storage                               |
| ---------------------- | --------------------------------- | ------------------------------------------------ |
| `standalone` (default) | Docker and Compose                | Existing game, state, SteamCMD, and home volumes |
| `pterodactyl`          | Custom yolk for Pterodactyl/Wings | The server's `/home/container` mount             |

Both targets use the same Sniper runtime, installer, version/checksum handling, configuration validation, and game supervisor. There is no second Pterodactyl Dockerfile. The separate SFTP sidecar image is only for standalone deployments; use Wings' own SFTP for panel servers.

## Build and generate an egg

From the project root:

```sh
docker build --target standalone -t cs2kz:standalone .
docker build --target pterodactyl -t ghcr.io/YOUR_OWNER/cs2kz:pterodactyl .
```

Replace `YOUR_OWNER` with your lowercase registry owner. Publish the Pterodactyl image to a registry your Wings node can pull from, then generate the import file with your real image reference and maintainer email:

```sh
docker run --rm --entrypoint cs2kz ghcr.io/YOUR_OWNER/cs2kz:pterodactyl egg \
  --image ghcr.io/YOUR_OWNER/cs2kz:pterodactyl \
  --author YOUR_EMAIL > /tmp/egg-cs2kz.json
```

The generator sets both the runtime image and installation image references. Choose a new output path; shell redirection replaces an existing file. The checked-in `egg-cs2kz.json` is a template; generate your import file instead of importing the placeholder reference.

1. Import the generated JSON into a nest in Pterodactyl's administrator interface.
2. Create a Linux x86-64 server using that egg and your published `pterodactyl` image.
3. Assign a game allocation and sufficient disk, memory, and installation time for the full CS2 download. The launch port comes from Wings' `SERVER_PORT` allocation, not a hardcoded Compose port.
4. Supply the Steam token through `GSLT` or the private configuration file. Leave other startup variables blank to use file settings.
5. Let installation finish, then start the server. Check console output and connect with a real CS2 client.

The egg's installation script runs the same installer against `/mnt/server`, the installer mount used by Wings. Runtime uses those files at `/home/container`. Installation does not download code from a moving source branch: the installer is part of your published image. Wings manages permissions on the persisted server files after installation. Runtime bootstrap also supports an empty writable mount when used without the egg's installation phase.

The readiness marker follows the official CS2 egg: `Connection to Steam servers successful`. Console output remains visible during installation/startup. A private or offline server that never connects to Steam may remain marked as starting even if the process runs.

## File layout and ownership

```text
/home/container/
  game/
    csgo/
      addons/
      cfg/
  steamapps/
  .cs2kz/
    config/
      settings.json
      server.cfg
      server-private.cfg
    state/
    steamcmd/
  .steam/
```

The image defines `USER container`, `HOME=/home/container`, and `WORKDIR /home/container`. It also works when Wings supplies a different numeric UID, as long as Wings gives that UID write access to the mounted server directory. No writable `/opt`, `/server`, `/state`, or `/run` mount is required. SteamCMD is copied from the image bootstrap into the server's own persistent directory. The local control socket lives under `/tmp/cs2kz` and is not part of Wings' SFTP mount.

Default configuration files are created only when absent. New panel installations default to **no internal scheduled maintenance** so that you can use panel schedules. Existing configuration survives image recreation and reinstalls; choose your update/pinning policy before reinstalling a frozen server.

## Settings, optional plugins, and pinning

Edit `.cs2kz/config/settings.json` through the panel file manager or Wings SFTP. Its schema is the same as the standalone setup. Configure every optional component as `latest`, a fixed release version, or `off`. Metamod and CS2KZ remain required. SHA256 checks and `game.expected_build` work in both targets.

The egg exposes optional startup overrides:

- Game update/validation switches, branch, expected build, starting map/Workshop map, and player slots.
- All five component versions and optional SHA256 checksums.
- Maintenance interval and warning duration.
- Steam login token and RCON password.

**Blank means use the configuration file.** Nonblank variables override file values on every startup and maintenance update. To pin through the file, clear conflicting startup overrides. To return a pinned component to `latest`, clear its checksum in both the startup variables and settings file. The allocation port always wins when `SERVER_PORT` is supplied.

`GSLT` and `RCON_PASSWORD` are written to `.cs2kz/config/server-private.cfg` before installation/startup. Blank variables preserve existing file values; clear the file too if you want to remove a previously supplied credential. RCON passwords supplied as variables accept letters, digits, underscores, and hyphens, with at least 16 characters required by the egg. A random password is generated when the private file is first created. Secrets are not echoed or included in the startup command. These are normal panel variables, not masked secret storage; use file-based credentials and panel permissions when appropriate.

Put a complete `cs2kz-server-config.txt` in `.cs2kz/config/` to use a persistent override. Obtain the initial file from `game/csgo/cfg/` after installation. `server.cfg`, `server-private.cfg`, and this optional override are copied into game configuration during startup and updates. With no override, edit the installed CS2KZ config directly and reload it through the console.

Use the same freeze policy described in the main README: disable game updates, record the installed Steam build ID, pin component versions/checksums, and keep a backup of the working installation. Installed versions/checksums are recorded in `.cs2kz/state/*.json`; the Steam build ID is in `steamapps/appmanifest_730.acf`. Do not assume SteamCMD can recreate arbitrary historical builds. Use the panel for server management.

## Console, power, schedules, backups, and SFTP

- Panel console input reaches the supervised game process. Use ordinary commands such as `status`, `meta list`, and `kz_reload_config`.
- The egg's `quit` command shuts down the supervisor and game gracefully. OS termination signals are handled as well.
- Send `cs2kz_update` in the console to queue maintenance with the configured warning. Pinning remains respected.
- For periodic updates, schedule `cs2kz_update` in the panel, or opt into the internal `MAINTENANCE_HOURS` interval. Avoid scheduling both for the same server.
- Panel power restart applies startup update policy immediately; use the warned update command if players are connected.
- Use Wings' existing SFTP endpoint and per-server permissions. Do not deploy the standalone SFTP sidecar beside a panel server.
- Stop the server before a consistent panel backup. Include hidden files: `.cs2kz` contains configuration, updater state, and SteamCMD. Back up an external MySQL database separately.

Startup updates and scheduled maintenance share the same installer. Updating the yolk itself remains a deliberate image publish/pull/recreate operation; the runtime does not access the Docker socket or manage Wings. A failure stops startup instead of launching a partially updated plugin set. See the main README for backup and update limitations.

## Extend the yolk

Build with `--target pterodactyl` whenever you need the panel layout. You can add shared dependencies to the existing `runtime` stage or panel-only dependencies to its `pterodactyl` stage. The default final stage remains `standalone`, and generated Compose files explicitly select it.

The Pterodactyl entrypoint honors `STARTUP`, including `{{VARIABLE}}` placeholders and Bash startup syntax. Placeholders become normal environment-variable references rather than evaluating variable contents as shell code. Quote placeholders that must remain a single argument. Keep the supplied startup command to retain the managed installer/supervisor workflow; a custom startup executable takes responsibility for its own game startup and console behavior.

To derive another image from a published Pterodactyl target, use that target's published tag as your downstream base and keep the `container` user, home, work directory, and entrypoint. An unrelated stock yolk cannot run this egg's installer unless it also contains this project's `/opt/cs2kz` runtime and Sniper dependencies.

The shared runtime also accepts `SERVER_DIR`, `STATE_DIR`, `CONFIG_DIR`, `STEAMCMD_DIR`, and `CONTROL_SOCKET` for an administrator-controlled integration. Configure all paths consistently; the provided targets already set suitable defaults.

References: [Pterodactyl custom images](https://pterodactyl.io/community/config/eggs/creating_a_custom_image.html), [custom eggs](https://pterodactyl.io/community/config/eggs/creating_a_custom_egg.html), and the [official CS2 egg](https://github.com/pterodactyl/game-eggs/blob/main/counter_strike/counter_strike_2/egg-counter--strike2.json).

# CS2KZ Docker

A standalone CS2KZ server project built on Valve's **Steam Runtime 3 / Sniper**. Generate a private Compose deployment, start it, and manage the server without publishing an administration API or RCON port.

The image contains the runtime libraries, SteamCMD bootstrap, component installer, and process supervisor. On first start it downloads **CS2 (Steam app 730)**, **Metamod**, **CS2KZ**, and the selected optional companions into persistent Docker volumes. Game content is installed at runtime rather than baked into a large, quickly outdated image.

| Feature             | Behavior                                                                            |
| ------------------- | ----------------------------------------------------------------------------------- |
| Setup               | Browser-based Compose generator; no host runtime required                           |
| Optional components | SQL_MM, MultiAddonManager, CS2Menus: individually `latest`, pinned, or `off`        |
| Updates             | Startup updates and configurable maintenance restarts, with a player warning        |
| Pinning             | Release versions, optional archive SHA256 checks, and installed CS2 build freezing  |
| Administration      | Start, stop, restart, logs, console commands, version reporting, backups            |
| Configuration       | Editable host files, persistent plugin configs, optional host CS2KZ override        |
| SFTP                | Optional separate OpenSSH container, key-only login, chroot, no shell or forwarding |
| Persistence         | Separate game, updater state, SteamCMD, home, and optional SSH host-key volumes     |

## Standalone or Pterodactyl

The same game-server Dockerfile builds both environments. Its default `standalone` target preserves the Compose setup below; `docker build --target pterodactyl` builds the panel-compatible yolk with the `container` user, `/home/container` storage, and panel console input. The installer, optional components, and pinning are shared.

See the [Pterodactyl guide](pterodactyl/README.md) for egg generation, installation, configuration, Wings SFTP, and extending the yolk.

## Browser generator

Open `docs/index.html` directly in a browser, or use the [hosted generator](https://busheezy.github.io/cs2kz-docker/). No host runtime, package installation, or backend is needed to use the generator. It produces a ZIP with Compose, runtime settings, server configuration, optional SFTP keys/CS2KZ overrides, and launch instructions. Credentials are generated/processed locally and are never sent to a server or saved in browser storage.

For **Build from this repository**, extract the downloaded server folder into this project's `deployments/` directory. The generated build context points to the same shared Dockerfile and selects `standalone`. For **Use a published image**, supply your standalone image reference and extract anywhere; supply your SFTP image too if enabling SFTP. These modes do not assume an image has already been published for this project.

From the extracted deployment folder, follow `START-HERE.md` and run `docker compose up -d --build` for a local build, or `docker compose up -d` for published images. Only Docker and Compose are required on the host.

### Publish the generator on GitHub Pages

The workflow at `.github/workflows/pages.yaml` publishes only `docs/`, keeping deployment configurations and credentials out of the website artifact.

1. Push this repository to GitHub with `main` as the default branch.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run **Publish Compose generator** from Actions, or push a change under `docs/`.
4. Open the URL reported by the deployment. Project Pages subpaths work because all assets use relative paths.

No website build step or hosting secrets are needed. The workflow also supports manual dispatch. Adjust its branch filter if the repository uses a different default branch. Local preview is simply opening `docs/index.html`; the site makes no API requests and uses no third-party scripts or fonts.

## Quick start

Use a Linux x86-64 host with Docker Compose v2.20+. Allow space for the complete game, maps, replays, and backups; start with at least 100 GB available.

Generate and extract your deployment using the browser generator, then follow its START-HERE.md. In the extracted deployment directory:

```sh
chmod 700 .
chmod 755 config
chmod 644 config/*
docker compose config --quiet
docker compose up -d --build
docker compose logs -f server
```

Supply a [Steam Game Server Login Token for app 730](https://steamcommunity.com/dev/managegameservers) in config/server-private.cfg. Give each instance its own project name, folder, port, and token. The generator includes a random RCON password; RCON is not published.

First installation can take a long time. Health checks allow 30 minutes of startup, then check the supervisor and local A2S response. Docker marks unhealthy containers but does not restart a hung process automatically; process exits restart through Compose.

A hand-editable example is in [examples/compose.yaml](examples/compose.yaml). Use the generator for a private deployment and generated credentials. Run the following management commands from your deployment directory.

## Choose components and update policy

Edit `config/settings.json` inside your deployment, then restart. All three optional components are enabled by default:

| Component           | Purpose                                            | Version syntax                       |
| ------------------- | -------------------------------------------------- | ------------------------------------ |
| `metamod`           | Required plugin loader                             | `latest` or `2.0.0-git1411`          |
| `cs2kz`             | Required KZ plugin, modes, styles, assets          | `latest` or exact GitHub release tag |
| `sql_mm`            | SQLite/MySQL local records and preferences         | `latest`, exact release tag, `off`   |
| `multiaddonmanager` | Workshop assets, radio menus, particle HUD, sounds | `latest`, exact release tag, `off`   |
| `cs2menus`          | HTML menu support                                  | `latest`, exact release tag, `off`   |

The installer chooses the Linux/Sniper archive, never MultiAddonManager's SteamRT4 build. GitHub tag spelling is significant, including a leading `v` when present. Use compatible sets of versions from the upstream release notes; `latest` does not establish compatibility between independently released projects. Metamod must be 2.0 build 1396 or later.

Each component has `version` and optional `sha256`. A checksum requires a fixed version. With `off`, managed loader descriptors and shared libraries are removed on the next startup/update; configs and data remain. Unmanaged plugin files are not removed. Re-enabling installs the package again.

`latest` resolves stable published GitHub releases, not development branch commits or CI artifacts. Installation records include resolved versions, source URLs, archive digests, and managed file paths in the private `state` volume.

| Setting                       | Default    | Meaning                                                                                          |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `game.update`                 | `true`     | Run SteamCMD on startup and maintenance                                                          |
| `game.branch`                 | `public`   | Steam branch; password-protected branches are not supported                                      |
| `game.expected_build`         | empty      | Require an already installed Steam build; requires `update: false`                               |
| `game.validate`               | `false`    | Ask SteamCMD to validate game files when it runs                                                 |
| `maintenance.interval_hours`  | `24`       | Restart and run the installer at this interval after startup; `0` disables scheduled maintenance |
| `maintenance.warning_seconds` | `60`       | In-game warning before scheduled or manually queued maintenance                                  |
| `game.port`                   | `27015`    | Game UDP port; update the Compose port mapping too if changing later                             |
| `game.map`                    | `de_dust2` | Initial built-in map                                                                             |
| `game.workshop_map`           | empty      | Numeric Workshop map ID; overrides `game.map`                                                    |
| `game.maxplayers`             | `16`       | Player slot limit                                                                                |
| `game.extra_args`             | `[]`       | Additional launch arguments as separate strings, never shell code                                |

Scheduled maintenance performs a restart even if no newer versions exist. Set the interval to `0` if you prefer to schedule `docker compose exec -T server cs2kz update` from your host's maintenance system. The default interval is measured from startup, not a fixed time of day. A manual update respects game freezing and component pins; it does not override them.

Game files are never updated while the supervised game process is running. Installer failures prevent game launch and appear in container logs; Compose retries on a later restart. Updates are not a transactional rollback of the whole game/plugin set. Take a full backup before important changes. Configs are preserved around SteamCMD updates; the last five configuration snapshots remain in `state/config-backups`. Plugin archives seed missing configs but do not overwrite existing configs.

### Freeze a working installation

```sh
docker compose exec -T server cs2kz versions
docker compose exec -T server cs2kz freeze > config/settings.frozen.json &&
mv config/settings.frozen.json config/settings.json
chmod 644 config/settings.json
docker compose restart server
../../scripts/backup.sh /path/to/cs2kz-frozen.tar.gz
```

`freeze` records installed component versions and archive checksums, disables scheduled maintenance, and records the installed CS2 build with game updates disabled. Keep the full backup: SteamCMD does not reliably provide arbitrary historical CS2 builds. An empty volume cannot be bootstrapped with `expected_build` set. Restore your matching game/state backup first.

To resume updates, clear `game.expected_build`, set `game.update` to `true`, and set selected components back to `latest` with empty checksums. Restore your chosen maintenance interval, then restart.

For reproducible base images, set the generator’s base image fields to `registry.gitlab.steamos.cloud/steamrt/sniper/platform@sha256:...` and, if using SFTP, `debian@sha256:...`. Replace the dots with verified digests. The game/component updater does not replace Docker images or OS packages. Rebuild deliberately to apply base-image/security updates:

```sh
docker compose build --pull
docker compose up -d
```

SteamCMD updates its own client when run; freezing CS2 freezes game content, not Valve's bootstrap client. An already installed pinned component does not need a release lookup unless its managed files are missing or its checksum policy changed.

## Configure CS2 and CS2KZ

Your deployment's host configuration is mounted read-only at `/config`:

- `server.cfg`: hostname, server password, ordinary console settings.
- `server-private.cfg`: Steam token and RCON password.
- `settings.json`: installation, launch, and maintenance policy.
- `cs2kz-server-config.txt`: optional complete override of the release's CS2KZ config.

Export the release's initial config after the first successful installation:

```sh
docker compose cp server:/server/game/csgo/cfg/cs2kz-server-config.txt config/cs2kz-server-config.txt
chmod 644 config/cs2kz-server-config.txt
```

Edit the exported file for default modes/styles, language, database settings, replay/log retention, and the optional global API key. Restart to copy host changes into the game's configuration. The complete upstream config stays authoritative; this project does not maintain a partial, outdated duplicate of the KZ schema.

SQLite is the default and lives with the game data when SQL_MM is enabled. For MySQL, use the upstream `db` block with a separately managed database reachable from the server container; do not publish its port just for this setup. This project does not provision MySQL or the CS2KZ global API. A Steam token is distinct from a CS2KZ global API key.

With no host CS2KZ override, edit the installed config through SFTP and send `kz_reload_config` through the console. A host override is recopied on startup/update, so choose one source of truth. `server.cfg` and `server-private.cfg` are always recopied from the host.

Follow the generated instructions to set the deployment directory to mode `0700`; mounted config files are readable by the container's UID `10000`. Keep the parent directory private. Do not commit deployment credentials or backups. The game directory necessarily contains runtime copies of game credentials, which trusted SFTP users can read.

## Operate the server

```sh
docker compose exec server cs2kz status
docker compose logs -f server
docker compose exec server cs2kz command status
docker compose exec server cs2kz command meta list
docker compose exec server cs2kz command kz_globalcheck
docker compose exec server cs2kz command 'say Maintenance starts shortly'
docker compose exec server cs2kz update
docker compose restart server
docker compose stop
docker compose start
docker compose down
```

Console responses appear in server logs. Commands use a permission-restricted Unix socket inside the game container; there is no host administration listener and no Docker socket mount. `update` queues a warned maintenance restart. `restart` restarts the container immediately and applies startup installation policy. `stop` gracefully stops all services. `down` removes containers/networks while preserving volumes; never add `--volumes` unless you intend to delete data.

Open the chosen game UDP port in your provider/host firewall. Bind RCON only to a management address if you add it yourself. Docker's published ports interact with host firewall rules; verify actual access from another machine.

After first launch, check `meta version`, `meta list`, and `kz_globalcheck` through `cs2kz command`, then connect with a real CS2 client. Verify Workshop downloads, HUD/sounds, a completed run, `!spb`, and database connection logs. Health status alone does not verify plugin compatibility or gameplay.

## Optional SFTP

Enable SFTP in the browser generator and paste your public SSH key. From the generated deployment folder:

```sh
docker compose up -d --build
sftp -P 2222 game@127.0.0.1
```

The account sees only `/files`, containing that deployment's complete game installation. SSH host keys persist across container recreation. The container has a separate network, no game control socket, no state/home/SteamCMD volume, no host directory mount, and no Docker socket. Its root filesystem is read-only. Authentication requires your public key; password login, shell commands, TTYs, tunnels, and forwarding are disabled.

The published address defaults to **localhost only**. For remote access, tunnel through your host's SSH account:

```sh
ssh -N -L 2222:127.0.0.1:2222 host-admin@your-server
sftp -P 2222 game@127.0.0.1
```

Alternatively change the SFTP mapping to a VPN interface address. Check the server host-key fingerprint before trusting a new endpoint:

```sh
docker compose exec sftp ssh-keygen -lf /hostkeys/ssh_host_ed25519_key.pub
```

Edit `authorized_keys` and restart SFTP to rotate access. Add one plain public key per line. Grant access only to trusted game administrators: uploading game binaries/plugins grants code execution as the game user, and game files include credentials. The chroot restricts SFTP paths; Docker shares the host kernel. Use a separate VM per tenant if you require a hard boundary against hostile tenants. Do not describe container/chroot isolation as an absolute security guarantee.

Stop SFTP during manual updates or binary uploads. Scheduled installation does not lock an active SFTP session; administrators must avoid editing files during the maintenance window.

## Back up and restore

```sh
../../scripts/backup.sh /path/to/cs2kz-backup.tar.gz
```

Run the repository’s `scripts/backup.sh` from your deployment folder (adjust the script path if using a published image deployment elsewhere). The command stops services, archives the entire game, updater state, and configuration, then resumes only services that were previously running. The destination must be new. Backups are mode `0600` and contain secrets. Store them outside this project and copy them off-host. Retain `compose.yaml`, `authorized_keys`, and SSH host keys separately. External MySQL requires its own consistent database backup.

To restore on the same deployment, stop services and extract a trusted archive into its mounted game/state volumes. Inspect the archive first. The following restores game/state; recover the archive's `config/` separately into the host deployment config directory:

```sh
docker compose stop
docker compose run --rm --no-deps -T --entrypoint tar server -xzf - -C / server state < /path/to/cs2kz-backup.tar.gz
docker compose start
```

Restore into empty game/state volumes for an exact rollback; extracting over a newer installation can leave newer files behind. Set the frozen policy before first start to prevent an immediate upgrade. On a new host, generate a deployment, build its image, restore data with the one-off command above, and use `up` to create/start its services. Match the original volume/project names intentionally. Do not delete a working volume to prepare a restore without an independently verified backup.

## Troubleshooting and upstream references

- Installation fails: inspect logs for SteamCMD, archive selection, checksum, or upstream rate-limit errors. Retry after resolving the underlying cause; do not delete persistent data.
- Missing optional functionality: check component selections and `meta list`, then verify client Workshop assets.
- Missing gameinfo entry: startup repairs Metamod's SearchPaths entry after SteamCMD completes.
- Steam login fails: confirm the unique app-730 token, outbound connectivity, and `/home/cs2kz/.steam/sdk64/steamclient.so`.
- SFTP fails: verify the key is public, the service was enabled during generation, and the localhost/VPN connection path.
- GitHub rate limiting: optionally mount a read-only secret at `/run/secrets/github_token` in the game service. The installer uses it only for GitHub API metadata, never third-party archive downloads.

Upstream documentation: [Valve Steam Runtime](https://github.com/ValveSoftware/steam-runtime), [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD), [CS2KZ requirements](https://github.com/KZGlobalTeam/cs2kz-metamod#requirements), [Metamod installation](https://wiki.alliedmods.net/Installing_Metamod:Source#Source_2), [Compose services](https://docs.docker.com/reference/compose-file/services/), and [OpenSSH server configuration](https://man.openbsd.org/sshd_config).

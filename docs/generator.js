"use strict";

const componentCatalog = [
  {
    id: "metamod",
    name: "Metamod",
    description: "The plugin loader CS2KZ runs on.",
    required: true,
  },
  {
    id: "cs2kz",
    name: "CS2KZ",
    description: "KZ gameplay, modes, styles, and assets.",
    required: true,
  },
  { id: "sql_mm", name: "SQL_MM", description: "Local records and player preferences." },
  {
    id: "multiaddonmanager",
    name: "MultiAddonManager",
    description: "Workshop assets, sounds, and particle HUD.",
  },
  { id: "cs2menus", name: "CS2Menus", description: "HTML menu support." },
];

function integer(value, low, high, label) {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new Error(`${label} must be a whole number between ${low} and ${high}.`);
  }
  return value;
}

function validateImage(value, label) {
  if (!/^[a-z0-9][a-z0-9./_:@-]+$/.test(value)) {
    throw new Error(`${label} must be a lowercase Docker image reference.`);
  }
}

function yaml(value, indent = 0) {
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    const label = Array.isArray(value) ? "-" : `${key}:`;
    const prefix = " ".repeat(indent);
    if (item !== null && typeof item === "object" && Object.keys(item).length) {
      lines.push(prefix + label, yaml(item, indent + 2));
      continue;
    }
    lines.push(`${prefix}${label} ${JSON.stringify(item)}`);
  }
  return lines.join("\n");
}

function createSettings(values) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(values.name)) {
    throw new Error("Use a project name with lowercase letters, numbers, hyphens, or underscores.");
  }
  if (!values.hostname || values.hostname.length > 128 || /[\r\n\0";\\]/.test(values.hostname)) {
    throw new Error("Server name cannot contain quotes, semicolons, backslashes, or line breaks.");
  }
  if (!/^[A-Za-z0-9]*$/.test(values.gslt)) {
    throw new Error("The Steam login token must contain only letters and numbers.");
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(values.rcon)) {
    throw new Error("Use an RCON password of 16–128 letters, numbers, hyphens, or underscores.");
  }
  for (const field of ["map", "branch"]) {
    if (!/^[A-Za-z0-9_./-]+$/.test(values[field])) {
      throw new Error(
        `Enter a valid ${field} using letters, numbers, underscores, dots, slashes, or hyphens.`,
      );
    }
  }
  for (const field of ["workshop_map", "expected_build"]) {
    if (!/^[0-9]*$/.test(values[field])) {
      throw new Error("Workshop map and installed build IDs must contain only numbers.");
    }
  }
  if (values.update && values.expected_build) {
    throw new Error("Disable game updates before requiring an installed build.");
  }
  let extraArgs;
  try {
    extraArgs = JSON.parse(values.extra_args || "[]");
  } catch {
    throw new Error("Extra launch arguments must be a valid JSON array of strings.");
  }
  if (
    !Array.isArray(extraArgs) ||
    !extraArgs.every((arg) => typeof arg === "string" && !/[\r\n\0]/.test(arg))
  ) {
    throw new Error("Extra launch arguments must be an array of strings without line breaks.");
  }
  const components = {};
  for (const component of componentCatalog) {
    const selected = values.components[component.id];
    if (!selected || !/^[A-Za-z0-9_.-]+$/.test(selected.version)) {
      throw new Error(`Enter a release version for ${component.name}.`);
    }
    if (selected.version === "off" && component.required) {
      throw new Error(`${component.name} is required.`);
    }
    if (
      selected.sha256 &&
      (!/^[a-fA-F0-9]{64}$/.test(selected.sha256) || ["latest", "off"].includes(selected.version))
    ) {
      throw new Error(
        `${component.name} needs a fixed version and a 64-character hexadecimal SHA256.`,
      );
    }
    components[component.id] = { version: selected.version, sha256: selected.sha256.toLowerCase() };
  }
  return {
    game: {
      update: values.update,
      branch: values.branch,
      expected_build: values.expected_build,
      validate: values.validate,
      port: integer(values.port, 1024, 65535, "Game port"),
      map: values.map,
      workshop_map: values.workshop_map,
      maxplayers: integer(values.maxplayers, 1, 64, "Player slots"),
      extra_args: extraArgs,
    },
    maintenance: {
      interval_hours: integer(values.interval_hours, 0, 8760, "Maintenance interval"),
      warning_seconds: integer(values.warning_seconds, 0, 3600, "Maintenance warning"),
    },
    components,
  };
}

function createCompose(values) {
  if (!["build", "image"].includes(values.source)) {
    throw new Error("Choose an image source.");
  }
  const server = {};
  if (values.source === "build") {
    validateImage(values.base_image, "Sniper base image");
    server.build = {
      context: "../..",
      target: "standalone",
      args: { BASE_IMAGE: values.base_image },
    };
    server.image = `${values.name}:local`;
  } else {
    validateImage(values.image, "Standalone image");
    server.image = values.image;
  }
  Object.assign(server, {
    platform: "linux/amd64",
    restart: "unless-stopped",
    user: "10000:10000",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 512,
    stop_grace_period: "90s",
    shm_size: "1gb",
    ports: [`${values.port}:${values.port}/udp`],
    volumes: [
      "game:/server",
      "state:/state",
      "steamcmd:/opt/steamcmd",
      "home:/home/cs2kz",
      {
        type: "bind",
        source: "./config",
        target: "/config",
        read_only: true,
        bind: { create_host_path: false },
      },
    ],
    tmpfs: [
      "/tmp:rw,nosuid,nodev,size=1g",
      "/run/cs2kz:rw,nosuid,nodev,noexec,uid=10000,gid=10000,mode=0700",
    ],
    ulimits: { nofile: { soft: 65536, hard: 65536 } },
    logging: { driver: "local", options: { "max-size": "20m", "max-file": "5" } },
  });
  const compose = {
    name: values.name,
    services: { server },
    volumes: { game: {}, state: {}, steamcmd: {}, home: {} },
  };
  if (!values.sftp) {
    return compose;
  }
  integer(values.sftp_port, 1024, 65535, "SFTP port");
  const keys = values.keys
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (
    !keys.length ||
    !keys.every((key) => /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: |$)/.test(key))
  ) {
    throw new Error(
      "SFTP needs at least one OpenSSH public key, with one key per line. Never use a private key.",
    );
  }
  const sftp = {};
  if (values.source === "build") {
    validateImage(values.sftp_base, "SFTP base image");
    sftp.build = { context: "../../sftp", args: { SFTP_BASE_IMAGE: values.sftp_base } };
    sftp.image = `${values.name}-sftp:local`;
  } else {
    validateImage(values.sftp_image, "SFTP image");
    sftp.image = values.sftp_image;
  }
  Object.assign(sftp, {
    restart: "unless-stopped",
    read_only: true,
    depends_on: { server: { condition: "service_started" } },
    cap_drop: ["ALL"],
    cap_add: ["SYS_CHROOT", "SETUID", "SETGID", "KILL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 64,
    ports: [`127.0.0.1:${values.sftp_port}:2222`],
    volumes: ["game:/srv/jail/files", "hostkeys:/hostkeys"],
    secrets: ["authorized_keys"],
    tmpfs: ["/run:rw,nosuid,nodev,noexec", "/tmp:rw,nosuid,nodev,noexec"],
    networks: ["sftp"],
    logging: server.logging,
  });
  compose.services.sftp = sftp;
  compose.volumes.hostkeys = {};
  compose.secrets = { authorized_keys: { file: "./authorized_keys" } };
  compose.networks = { sftp: { internal: true } };
  return compose;
}

function createInstructions(values) {
  let location = `Extract the ${values.name} folder anywhere on your Docker host.`;
  let launch = "docker compose up -d";
  if (values.source === "build") {
    location = `Download or clone the CS2KZ Docker repository containing the generator. Extract the ${values.name} folder into its deployments/ directory, so the Compose file is at deployments/${values.name}/compose.yaml. The build context points two directories up to the project Dockerfile.`;
    launch += " --build";
  }
  let text = `# ${values.name}\n\n## Start your server\n\n1. ${location}\n2. Open a terminal in the extracted ${values.name} folder.\n3. Add your app 730 Steam token to config/server-private.cfg if it is still blank.\n4. On a Linux host, protect the deployment directory and make the mounted config readable by the game user:\n\n\`\`\`sh\nchmod 700 .\nchmod 755 config\nchmod 644 config/*\ndocker compose config --quiet\n${launch}\ndocker compose logs -f server\n\`\`\`\n\nOnly Docker and Compose are needed on the host. Python runs inside the supplied image. Use a Linux x86-64 host and an executable game volume, with enough space for the complete CS2 installation, maps, and backups. First-start downloads can take a long time. Open UDP ${values.port} in your host/provider firewall. RCON is not published.\n\n## Server controls\n\n\`\`\`sh\ndocker compose ps\ndocker compose exec server python3 /opt/cs2kz/control.py command status\ndocker compose exec server python3 /opt/cs2kz/control.py command meta list\ndocker compose exec server python3 /opt/cs2kz/control.py update\ndocker compose restart server\ndocker compose stop\ndocker compose start\n\`\`\`\n\nEdit config/settings.json for plugin choices, version pins, launch settings, and maintenance. Edit config/server.cfg for the hostname and game settings. Restart to apply changes. Scheduled maintenance restarts even when no updates are available. Disabling game updates preserves an installed build; a required build ID needs a matching restored installation. Take a full backup before updates and before changing version pins. Never use docker compose down --volumes unless you intend to delete server data.\n\nThe optional config/cs2kz-server-config.txt override is copied into the game on startup. Without it, the release's config is used.\n\nThis archive contains credentials. Keep the deployment directory private and out of version control. ZIP extraction tools may not preserve Unix permissions; use the commands above. The generator does not send or store credentials.\n`;
  if (values.sftp) {
    text += `\n## SFTP\n\nConnect as game on localhost port ${values.sftp_port}, using a private key matching an entry in authorized_keys. For remote access, use a host SSH tunnel:\n\n\`\`\`sh\nssh -N -L ${values.sftp_port}:127.0.0.1:${values.sftp_port} host-admin@your-server\nsftp -P ${values.sftp_port} game@127.0.0.1\n\`\`\`\n\nSFTP exposes only this installation at /files. Access permits changing game binaries and reading game credentials, so grant it only to trusted administrators. Use a separate VM for hostile-tenant isolation. Stop SFTP while uploading binaries or applying updates. Host keys persist in their own volume.\n`;
  }
  return text;
}

function generate(values) {
  const settings = createSettings(values);
  const compose = createCompose(values);
  const files = {
    "compose.yaml": yaml(compose) + "\n",
    "config/settings.json": JSON.stringify(settings, null, 2) + "\n",
    "config/server.cfg": `hostname "${values.hostname}"\nsv_lan 0\nsv_cheats 0\nsv_password ""\nlog on\n`,
    "config/server-private.cfg": `sv_setsteamaccount "${values.gslt}"\nrcon_password "${values.rcon}"\n`,
    "START-HERE.md": createInstructions(values),
    ".gitignore": "*\n",
  };
  if (values.sftp) {
    files.authorized_keys = values.keys.trim() + "\n";
  }
  if (values.kz_config.trim()) {
    files["config/cs2kz-server-config.txt"] = values.kz_config.trim() + "\n";
  }
  return { files, settings, compose };
}

function createZip(files, folder) {
  const encoder = new TextEncoder();
  const entries = [
    [`${folder}/`, "", 0o40700],
    [`${folder}/config/`, "", 0o40755],
  ];
  for (const [name, content] of Object.entries(files)) {
    entries.push([`${folder}/${name}`, content, 0o100644]);
  }
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let centralSize = 0;
  for (const [name, content, mode] of entries) {
    const filename = encoder.encode(name);
    const data = encoder.encode(content);
    let checksum = 0xffffffff;
    for (const byte of data) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
      }
    }
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + filename.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true);
    header.setUint16(12, 33, true);
    header.setUint32(14, checksum, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 0x0314, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(14, 33, true);
    record.setUint32(16, checksum, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, filename.length, true);
    record.setUint32(38, ((mode << 16) | (name.endsWith("/") ? 16 : 0)) >>> 0, true);
    record.setUint32(42, offset, true);
    central.set(filename, 46);
    localParts.push(local, data);
    centralParts.push(central);
    offset += local.length + data.length;
    centralSize += central.length;
  }
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, entries.length, true);
  footer.setUint16(10, entries.length, true);
  footer.setUint32(12, centralSize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

globalThis.CS2KZ = { componentCatalog, generate, createZip };

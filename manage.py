import argparse
import getpass
import json
import re
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "runtime"))
from settings import COMPONENTS, read_settings


def prompt(label, default):
    value = input(label + " [" + str(default) + "]: ").strip()
    return value or str(default)


def yaml_lines(value, indent=0):
    lines = []
    prefix = " " * indent
    entries = value.items() if isinstance(value, dict) else enumerate(value)
    for key, item in entries:
        label = str(key) + ":" if isinstance(value, dict) else "-"
        if isinstance(item, (dict, list)) and item:
            lines.append(prefix + label)
            lines.extend(yaml_lines(item, indent + 2))
            continue
        lines.append(prefix + label + " " + json.dumps(item))
    return lines


def generate(args):
    target = Path(args.directory).resolve()
    if target.exists():
        raise ValueError("Choose a new directory; existing deployments are never overwritten")
    settings = read_settings(ROOT / "config/settings.json")
    name = args.name
    token = ""
    if not args.defaults:
        name = prompt("Compose project name", name)
        settings["game"]["port"] = int(prompt("Game UDP port", 27015))
        settings["game"]["maxplayers"] = int(prompt("Player slots", 16))
        settings["game"]["workshop_map"] = input("Initial Workshop map ID (blank for de_dust2): ").strip()
        token = getpass.getpass("Steam game server login token (hidden; may be added later): ").strip()
        for component in COMPONENTS:
            choice = "latest, a fixed version" if component in ["metamod", "cs2kz"] else "latest, off, a fixed version"
            settings["components"][component]["version"] = prompt(component + " (" + choice + ")", "latest")
        settings["game"]["update"] = prompt("Update CS2 on startup (yes/no)", "yes").lower() == "yes"
        settings["maintenance"]["interval_hours"] = int(prompt("Maintenance restart interval in hours (0 disables)", 24))
        if not args.sftp_key:
            key = input("SFTP public key file (blank disables SFTP): ").strip()
            args.sftp_key = key or None
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name):
        raise ValueError("Project name must use lowercase letters, digits, underscores or hyphens")
    if not re.fullmatch(r"[A-Za-z0-9]*", token):
        raise ValueError("Invalid Steam token")
    key_text = None
    if args.sftp_key:
        key_text = Path(args.sftp_key).expanduser().read_text()
        lines = [line for line in key_text.splitlines() if line.strip()]
        if not lines or any(not re.match(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+(?: |$)", line) for line in lines):
            raise ValueError("Supply an OpenSSH public key file, never a private key")
    target.mkdir(parents=True, mode=0o700)
    target.chmod(0o700)
    config = target / "config"
    config.mkdir(mode=0o755)
    (config / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    read_settings(config / "settings.json")
    (config / "server.cfg").write_text('hostname "' + name + '"\nsv_lan 0\nsv_cheats 0\nsv_password ""\nlog on\n')
    (config / "server-private.cfg").write_text('sv_setsteamaccount "' + token + '"\nrcon_password "' + secrets.token_hex(24) + '"\n')
    for path in config.iterdir():
        path.chmod(0o644)
    port = settings["game"]["port"]
    service = {
        "build": {"context": str(ROOT), "target": "standalone", "args": {"BASE_IMAGE": args.base_image}},
        "image": name + ":local", "platform": "linux/amd64", "restart": "unless-stopped",
        "user": "10000:10000", "read_only": True, "cap_drop": ["ALL"],
        "security_opt": ["no-new-privileges:true"], "pids_limit": 512,
        "stop_grace_period": "90s", "shm_size": "1gb",
        "ports": [str(port) + ":" + str(port) + "/udp"],
        "volumes": ["game:/server", "state:/state", "steamcmd:/opt/steamcmd", "home:/home/cs2kz",
                    {"type": "bind", "source": "./config", "target": "/config", "read_only": True,
                     "bind": {"create_host_path": False}}],
        "tmpfs": ["/tmp:rw,nosuid,nodev,size=1g", "/run/cs2kz:rw,nosuid,nodev,noexec,uid=10000,gid=10000,mode=0700"],
        "ulimits": {"nofile": {"soft": 65536, "hard": 65536}},
        "logging": {"driver": "local", "options": {"max-size": "20m", "max-file": "5"}},
    }
    compose = {"name": name, "services": {"server": service},
               "volumes": {key: {} for key in ["game", "state", "steamcmd", "home"]}}
    if key_text:
        (target / "authorized_keys").write_text(key_text.strip() + "\n")
        (target / "authorized_keys").chmod(0o644)
        compose["services"]["sftp"] = {
            "build": {"context": str(ROOT / "sftp"), "args": {"SFTP_BASE_IMAGE": args.sftp_base_image}},
            "image": name + "-sftp:local", "restart": "unless-stopped", "read_only": True,
            "depends_on": {"server": {"condition": "service_started"}},
            "cap_drop": ["ALL"], "cap_add": ["SYS_CHROOT", "SETUID", "SETGID", "KILL"],
            "security_opt": ["no-new-privileges:true"], "pids_limit": 64,
            "ports": ["127.0.0.1:" + str(args.sftp_port) + ":2222"],
            "volumes": ["game:/srv/jail/files", "hostkeys:/hostkeys"],
            "secrets": ["authorized_keys"], "tmpfs": ["/run:rw,nosuid,nodev,noexec", "/tmp:rw,nosuid,nodev,noexec"],
            "networks": ["sftp"], "logging": service["logging"],
        }
        compose["volumes"]["hostkeys"] = {}
        compose["secrets"] = {"authorized_keys": {"file": "./authorized_keys"}}
        compose["networks"] = {"sftp": {"internal": True}}
    (target / "compose.yaml").write_text("\n".join(yaml_lines(compose)) + "\n")
    print("Created " + str(target / "compose.yaml"))
    print("Edit config/server-private.cfg to supply your Steam token before starting.")
    print("Start: python3 " + str(ROOT / "manage.py") + " --directory " + str(target) + " up")


def freeze_deployment(compose, directory):
    result = subprocess.run(compose + ["exec", "-T", "server", "python3", "/opt/cs2kz/control.py", "versions"],
                            check=True, capture_output=True, text=True)
    installed = json.loads(result.stdout)
    settings = read_settings(directory / "config/settings.json")
    settings["game"]["update"] = False
    settings["game"]["expected_build"] = installed["build"]
    settings["maintenance"]["interval_hours"] = 0
    for name in COMPONENTS:
        record = installed["components"].get(name)
        if not record:
            if name in ["metamod", "cs2kz"]:
                raise ValueError("Required component is not installed: " + name)
            settings["components"][name] = {"version": "off", "sha256": ""}
            continue
        version = record["resolved"]
        if name == "metamod":
            version = version.removeprefix("mmsource-").removesuffix("-linux.tar.gz")
        settings["components"][name] = {"version": version, "sha256": record["download_sha256"]}
    temporary = directory / "config/settings.json.tmp"
    temporary.write_text(json.dumps(settings, indent=2) + "\n")
    temporary.chmod(0o644)
    read_settings(temporary)
    temporary.replace(directory / "config/settings.json")
    print("Pinned installed game and component versions; restart to activate the frozen policy. Back up this installation.")


def backup_deployment(compose, output):
    destination = Path(output).resolve()
    if destination.exists():
        raise ValueError("Backup destination already exists")
    running = subprocess.run(compose + ["ps", "--services", "--status", "running"],
                             check=True, capture_output=True, text=True).stdout.split()
    with destination.open("xb") as archive:
        destination.chmod(0o600)
        try:
            subprocess.run(compose + ["stop"], check=True)
            subprocess.run(compose + ["run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "server",
                                      "-czf", "-", "-C", "/", "server", "state", "config"], stdout=archive, check=True)
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        finally:
            if running:
                subprocess.run(compose + ["start"] + running, check=True)
    print("Saved " + str(destination) + "; also retain compose.yaml and SFTP authorized_keys separately")


def main():
    parser = argparse.ArgumentParser(description="Generate and operate isolated CS2KZ Compose deployments")
    parser.add_argument("--directory", default="deployments/main", help="Deployment directory")
    commands = parser.add_subparsers(dest="action", required=True)
    setup = commands.add_parser("generate", help="Interactive Compose setup wizard")
    setup.add_argument("--defaults", action="store_true", help="Generate without prompts")
    setup.add_argument("--name", default="cs2kz")
    setup.add_argument("--sftp-key")
    setup.add_argument("--sftp-port", type=int, default=2222)
    setup.add_argument("--base-image", default="registry.gitlab.steamos.cloud/steamrt/sniper/platform:latest")
    setup.add_argument("--sftp-base-image", default="debian:bookworm-slim")
    egg = commands.add_parser("egg", help="Generate a Pterodactyl egg for your published image")
    egg.add_argument("--image", required=True)
    egg.add_argument("--author", required=True, help="Maintainer email required by Pterodactyl")
    egg.add_argument("--output", required=True)
    for action in ["up", "down", "start", "stop", "restart", "logs", "status", "update", "check", "versions", "freeze", "export-config"]:
        commands.add_parser(action)
    console = commands.add_parser("console")
    console.add_argument("command", nargs="+")
    backup = commands.add_parser("backup", help="Stop services, archive game/state, and resume previously running services")
    backup.add_argument("output", help="New .tar.gz archive path")
    args = parser.parse_args()
    if args.action == "egg":
        if not re.fullmatch(r"[a-z0-9][a-z0-9./_:@-]+", args.image):
            raise ValueError("Supply a lowercase Docker image reference")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", args.author):
            raise ValueError("Supply a maintainer email address")
        data = json.loads((ROOT / "pterodactyl/egg-cs2kz.json").read_text())
        data["author"] = args.author
        data["docker_images"] = {"CS2KZ Sniper": args.image}
        data["scripts"]["installation"]["container"] = args.image
        destination = Path(args.output).resolve()
        with destination.open("x") as output:
            output.write(json.dumps(data, indent=2) + "\n")
        print("Created " + str(destination) + "; import it into your Pterodactyl nest")
        return
    if args.action == "generate":
        if not 1024 <= args.sftp_port <= 65535:
            raise ValueError("SFTP port must be between 1024 and 65535")
        generate(args)
        return
    directory = Path(args.directory).resolve()
    read_settings(directory / "config/settings.json")
    compose = ["docker", "compose", "--project-directory", str(directory), "-f", str(directory / "compose.yaml")]
    if args.action == "freeze":
        freeze_deployment(compose, directory)
        return
    if args.action == "backup":
        backup_deployment(compose, args.output)
        return
    actions = {
        "up": ["up", "-d", "--build"], "down": ["down"], "start": ["start"], "stop": ["stop"],
        "restart": ["restart", "server"], "logs": ["logs", "--follow", "--tail", "100", "server"],
        "status": ["ps"], "check": ["config", "--quiet"],
        "update": ["exec", "-T", "server", "python3", "/opt/cs2kz/control.py", "update"],
        "console": ["exec", "-T", "server", "python3", "/opt/cs2kz/control.py", "command"] + getattr(args, "command", []),
        "versions": ["exec", "-T", "server", "python3", "/opt/cs2kz/control.py", "versions"],
    }
    if args.action == "export-config":
        destination = directory / "config/cs2kz-server-config.txt"
        if destination.exists():
            raise ValueError("Export destination exists; refusing to overwrite your configuration")
        subprocess.run(compose + ["cp", "server:/server/game/csgo/cfg/cs2kz-server-config.txt", str(destination)], check=True)
        destination.chmod(0o644)
        print("Edit " + str(destination) + "; restart to apply")
        return
    subprocess.run(compose + actions[args.action], check=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)

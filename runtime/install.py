import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from settings import COMPONENTS
from paths import CONFIG, GAME, SERVER, STATE, STEAMCMD


def fetch(url, destination):
    if urllib.parse.urlparse(url).scheme != "https":
        raise ValueError("Downloads require HTTPS")
    subprocess.run([
        "curl", "--fail", "--location", "--retry", "5", "--connect-timeout", "30",
        "--max-time", "600", "--proto", "=https", "--proto-redir", "=https",
        "--silent", "--show-error", "--output", str(destination), url,
    ], check=True)


def release(name, version):
    if name == "metamod":
        base = "https://www.metamodsource.net/mmsdrop/2.0/"
        if version == "latest":
            with tempfile.TemporaryDirectory() as folder:
                pointer = Path(folder) / "latest"
                fetch(base + "mmsource-latest-linux", pointer)
                filename = pointer.read_text().strip()
        else:
            filename = "mmsource-" + version + "-linux.tar.gz"
        if not re.fullmatch(r"mmsource-2\.0\.\d+-git\d+-linux\.tar\.gz", filename):
            raise ValueError("Unexpected Metamod filename: " + filename)
        return filename, base + filename
    endpoint = "latest"
    if version != "latest":
        endpoint = "tags/" + urllib.parse.quote(version, safe="")
    url = "https://api.github.com/repos/" + COMPONENTS[name] + "/releases/" + endpoint
    request = urllib.request.Request(url, headers={"User-Agent": "cs2kz-docker"})
    token = Path("/run/secrets/github_token")
    if token.exists() and token.read_text().strip():
        request.add_header("Authorization", "Bearer " + token.read_text().strip())
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    assets = [a for a in data["assets"] if (
        ("linux" in a["name"].lower() or "steamrt3" in a["name"].lower())
        and "upgrade" not in a["name"].lower()
        and "steamrt4" not in a["name"].lower()
        and a["name"].endswith((".tar.gz", ".zip"))
    )]
    if len(assets) != 1:
        raise ValueError("Expected one Linux/Sniper archive for " + name)
    return data["tag_name"], assets[0]["browser_download_url"]


def unpack(archive, target):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                mode = member.external_attr >> 16
                if mode & 0o170000 == 0o120000:
                    raise ValueError("Archive symlinks are not allowed")
                destination = safe_path(target, member.filename)
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.open(member) as incoming, destination.open("wb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                destination.chmod(0o755 if mode & 0o111 else 0o644)
        return
    with tarfile.open(archive) as source:
        for member in source:
            destination = safe_path(target, member.name)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError("Archive links and special files are not allowed")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as incoming, destination.open("wb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            destination.chmod(0o755 if member.mode & 0o111 else 0o644)


def safe_path(root, relative):
    destination = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("Unsafe archive or manifest path")
    if root.resolve() not in destination.resolve().parents and destination.resolve() != root.resolve():
        raise ValueError("Path escapes installation")
    return destination


def install_component(name, config):
    manifest_path = STATE / (name + ".json")
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    version = config["version"]
    if version == "off":
        for relative in previous.get("files", []):
            if relative.endswith((".so", ".vdf")):
                safe_path(GAME, relative).unlink(missing_ok=True)
        manifest_path.unlink(missing_ok=True)
        return
    installed_version = previous.get("resolved", "")
    if name == "metamod":
        installed_version = installed_version.removeprefix("mmsource-").removesuffix("-linux.tar.gz")
    if version != "latest" and installed_version == version:
        intact = all(safe_path(GAME, p).is_file() for p in previous.get("files", []))
        checksum_matches = not config.get("sha256") or previous.get("download_sha256") == config["sha256"].lower()
        if intact and checksum_matches:
            return
    resolved, url = release(name, version)
    if previous.get("resolved") == resolved and previous.get("sha256") == config.get("sha256", ""):
        if all(safe_path(GAME, p).is_file() for p in previous.get("files", [])):
            previous["requested"] = version
            manifest_path.write_text(json.dumps(previous, indent=2) + "\n")
            return
    with tempfile.TemporaryDirectory(dir=STATE) as folder:
        staging = Path(folder)
        archive = staging / "download"
        fetch(url, archive)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if config.get("sha256") and digest.lower() != config["sha256"].lower():
            raise ValueError("SHA256 mismatch for " + name)
        payload = staging / "payload"
        payload.mkdir()
        unpack(archive, payload)
        files = [p for p in payload.rglob("*") if p.is_file()]
        if not files or any(p.relative_to(payload).parts[0] not in ["addons", "cfg"] for p in files):
            raise ValueError("Unexpected archive layout for " + name)
        managed = []
        for source in files:
            relative = source.relative_to(payload).as_posix()
            destination = safe_path(GAME, relative)
            if relative.startswith("cfg/") and destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(destination.name + ".installing")
            shutil.copy2(source, temporary)
            temporary.replace(destination)
            if not relative.startswith("cfg/"):
                managed.append(relative)
        for relative in set(previous.get("files", [])) - set(managed):
            if relative.endswith((".so", ".vdf")):
                safe_path(GAME, relative).unlink(missing_ok=True)
        record = {"requested": version, "resolved": resolved, "sha256": config.get("sha256", ""),
                  "download_sha256": digest, "url": url, "files": managed}
        temporary = manifest_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(manifest_path)
        print("Installed " + name + " " + resolved, flush=True)


def install(settings):
    STATE.mkdir(parents=True, exist_ok=True)
    game = settings["game"]
    binary = SERVER / "game/bin/linuxsteamrt64/cs2"
    if game["expected_build"] and not binary.exists():
        raise ValueError("Restore the pinned CS2 installation before starting")
    if game["update"] or not binary.exists():
        args = [str(STEAMCMD / "steamcmd.sh"), "+force_install_dir", str(SERVER),
                "+login", "anonymous", "+app_update", "730"]
        if game["branch"] != "public":
            args += ["-beta", game["branch"]]
        else:
            args += ["-beta", "public"]
        if game["validate"]:
            args.append("validate")
        args.append("+quit")
        backup = None
        if (GAME / "cfg").is_dir():
            backups = STATE / "config-backups"
            backups.mkdir(exist_ok=True)
            backup = backups / str(time.time_ns())
            shutil.copytree(GAME / "cfg", backup, symlinks=True)
            for old in sorted(backups.iterdir())[:-5]:
                shutil.rmtree(old)
        try:
            subprocess.run(args, check=True, timeout=14400)
        finally:
            if backup:
                shutil.copytree(backup, GAME / "cfg", dirs_exist_ok=True, symlinks=True)
    if not binary.is_file():
        raise ValueError("SteamCMD did not install the CS2 executable")
    if not (STEAMCMD / "linux64/steamclient.so").is_file():
        subprocess.run([str(STEAMCMD / "steamcmd.sh"), "+quit"], check=True, timeout=900)
    manifest = SERVER / "steamapps/appmanifest_730.acf"
    if game["expected_build"]:
        match = re.search(r'"buildid"\s+"(\d+)"', manifest.read_text())
        if not match or match[1] != game["expected_build"]:
            raise ValueError("Installed CS2 build does not match expected_build")
    sdk = Path.home() / ".steam/sdk64"
    sdk.mkdir(parents=True, exist_ok=True)
    library = sdk / "steamclient.so"
    if not library.exists():
        library.unlink(missing_ok=True)
        library.symlink_to(STEAMCMD / "linux64/steamclient.so")
    for name, config in settings["components"].items():
        install_component(name, config)
    gameinfo = GAME / "gameinfo.gi"
    content = gameinfo.read_text()
    if not re.search(r"^\s*Game\s+csgo/addons/metamod\s*$", content, re.MULTILINE):
        content, count = re.subn(r"(SearchPaths\s*\{)", r"\1\n\t\t\tGame csgo/addons/metamod", content, count=1)
        if count != 1:
            raise ValueError("Cannot locate SearchPaths in gameinfo.gi")
        gameinfo.write_text(content)
    for filename in ["server.cfg", "server-private.cfg"]:
        source = CONFIG / filename
        if not source.is_file():
            raise ValueError("Missing " + str(source))
        destination = safe_path(GAME, "cfg/" + filename)
        shutil.copyfile(source, destination)
        destination.chmod(0o600)
    override = CONFIG / "cs2kz-server-config.txt"
    if override.is_file():
        destination = safe_path(GAME, "cfg/cs2kz-server-config.txt")
        shutil.copyfile(override, destination)
        destination.chmod(0o600)

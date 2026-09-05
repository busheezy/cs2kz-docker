import os
import re
import secrets
import shutil
import sys
from pathlib import Path

from paths import CONFIG, SERVER, STATE, STEAMCMD
from settings import read_settings


def prepare():
    for directory in [SERVER, STATE, CONFIG, STEAMCMD]:
        directory.mkdir(parents=True, exist_ok=True)
    marker = STEAMCMD / ".bootstrap-ready"
    if not marker.exists():
        shutil.copytree("/opt/steamcmd", STEAMCMD, dirs_exist_ok=True)
        marker.touch()
    defaults = Path("/opt/cs2kz/defaults")
    for filename in ["settings.json", "server.cfg"]:
        destination = CONFIG / filename
        if not destination.exists():
            shutil.copyfile(defaults / filename, destination)
    private = CONFIG / "server-private.cfg"
    if not private.exists():
        private.write_text('sv_setsteamaccount ""\nrcon_password "' + secrets.token_hex(24) + '"\n')
    content = private.read_text()
    for variable, command in [("GSLT", "sv_setsteamaccount"), ("RCON_PASSWORD", "rcon_password")]:
        value = os.environ.get(variable, "")
        if not value:
            continue
        if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError(variable + " must contain only letters, digits, underscores or hyphens")
        line = command + ' "' + value + '"'
        content, count = re.subn(r"(?m)^\s*" + command + r"\b[^\n]*$", lambda match: line, content)
        if not count:
            content += "\n" + line + "\n"
    private.write_text(content)
    private.chmod(0o600)
    read_settings()


def main():
    os.umask(0o077)
    prepare()
    if sys.argv[1:] == ["--install"]:
        from install import install
        install(read_settings())
        return
    startup = os.environ.get("STARTUP", "python3 /opt/cs2kz/server.py")
    if not startup.strip():
        raise ValueError("STARTUP must specify an executable")
    startup = re.sub(r"\{\{([A-Z0-9_]+)\}\}", r"${\1}", startup)
    os.chdir(SERVER)
    os.execvp("/bin/bash", ["/bin/bash", "-c", startup])


if __name__ == "__main__":
    main()

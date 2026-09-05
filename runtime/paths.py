import os
from pathlib import Path

SERVER = Path(os.environ.get("SERVER_DIR", "/server"))
GAME = SERVER / "game/csgo"
STATE = Path(os.environ.get("STATE_DIR", "/state"))
CONFIG = Path(os.environ.get("CONFIG_DIR", "/config"))
STEAMCMD = Path(os.environ.get("STEAMCMD_DIR", "/opt/steamcmd"))
SOCKET = Path(os.environ.get("CONTROL_SOCKET", "/run/cs2kz/control.sock"))
PTERODACTYL = os.environ.get("PTERODACTYL") == "1"

import json
import os
import re
from paths import CONFIG, PTERODACTYL

COMPONENTS = {
    "metamod": None,
    "cs2kz": "KZGlobalTeam/cs2kz-metamod",
    "sql_mm": "zer0k-z/sql_mm",
    "multiaddonmanager": "Source2ZE/MultiAddonManager",
    "cs2menus": "FemboyKZ/mm-cs2menus",
}


def read_settings(path=CONFIG / "settings.json"):
    data = json.loads(path.read_text())
    if PTERODACTYL:
        apply_panel_settings(data)
    game = data["game"]
    if type(game["update"]) is not bool or type(game["validate"]) is not bool:
        raise ValueError("game.update and game.validate must be booleans")
    for key, low, high in [("port", 1024, 65535), ("maxplayers", 1, 64)]:
        if type(game[key]) is not int or not low <= game[key] <= high:
            raise ValueError("Invalid game." + key)
    for key in ["map", "branch"]:
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", game[key]):
            raise ValueError("Invalid game." + key)
    for key in ["workshop_map", "expected_build"]:
        if not re.fullmatch(r"[0-9]*", game[key]):
            raise ValueError("Invalid game." + key)
    if game["update"] and game["expected_build"]:
        raise ValueError("expected_build requires update=false; restore a matching installation first")
    if not isinstance(game["extra_args"], list) or not all(
        isinstance(arg, str) and "\n" not in arg and "\x00" not in arg
        for arg in game["extra_args"]
    ):
        raise ValueError("extra_args must be an array of strings")
    for key, low, high in [("interval_hours", 0, 8760), ("warning_seconds", 0, 3600)]:
        value = data["maintenance"][key]
        if type(value) is not int or not low <= value <= high:
            raise ValueError("Invalid maintenance." + key)
    if set(data["components"]) != set(COMPONENTS):
        raise ValueError("Configure exactly the five supported components")
    for name, component in data["components"].items():
        version = component["version"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", version):
            raise ValueError("Invalid version for " + name)
        if version == "off" and name in ["metamod", "cs2kz"]:
            raise ValueError(name + " is required")
        digest = component.get("sha256", "")
        if digest and not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            raise ValueError("Invalid SHA256 for " + name)
        if digest and version in ["latest", "off"]:
            raise ValueError("SHA256 requires a fixed version")
    return data


def apply_panel_settings(data):
    fields = {
        "SERVER_PORT": ("game", "port", int),
        "CS2_BRANCH": ("game", "branch", str),
        "CS2_EXPECTED_BUILD": ("game", "expected_build", str),
        "CS2_MAP": ("game", "map", str),
        "CS2_WORKSHOP_MAP": ("game", "workshop_map", str),
        "CS2_MAXPLAYERS": ("game", "maxplayers", int),
        "MAINTENANCE_HOURS": ("maintenance", "interval_hours", int),
        "MAINTENANCE_WARNING": ("maintenance", "warning_seconds", int),
    }
    for variable, (section, key, convert) in fields.items():
        value = os.environ.get(variable, "")
        if value:
            data[section][key] = convert(value)
    for variable, key in [("CS2_UPDATE", "update"), ("CS2_VALIDATE", "validate")]:
        value = os.environ.get(variable, "")
        if value:
            if value not in ["0", "1"]:
                raise ValueError(variable + " must be 0 or 1")
            data["game"][key] = value == "1"
    for component in COMPONENTS:
        for suffix, key in [("VERSION", "version"), ("SHA256", "sha256")]:
            value = os.environ.get(component.upper() + "_" + suffix, "")
            if value:
                data["components"][component][key] = value

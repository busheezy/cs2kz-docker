import json
import os
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time

from install import install
from paths import PTERODACTYL, SERVER, SOCKET
from settings import read_settings


class Server:
    def __init__(self):
        self.process = None
        self.stopping = False
        self.settings = read_settings()
        self.maintenance_at = None
        self.update_at = None
        self.console_buffer = b""

    def schedule(self):
        hours = self.settings["maintenance"]["interval_hours"]
        self.maintenance_at = time.monotonic() + hours * 3600 if hours else None
        self.update_at = None

    def start(self):
        game = self.settings["game"]
        args = ["./cs2.sh", "-dedicated", "-console", "-usercon", "-port", str(game["port"]),
                "-maxplayers", str(game["maxplayers"]), "+exec", "server-private.cfg", "+exec", "server.cfg"]
        if game["workshop_map"]:
            args += ["+host_workshop_map", game["workshop_map"]]
        else:
            args += ["+map", game["map"]]
        args += game["extra_args"]
        self.process = subprocess.Popen(args, cwd=SERVER / "game", stdin=subprocess.PIPE,
                                        text=True, start_new_session=True)
        self.schedule()

    def command(self, command):
        if not self.process or self.process.poll() is not None:
            raise ValueError("Server is not running")
        if not command or any(c in command for c in ["\n", "\r", "\x00"]):
            raise ValueError("Send one console command at a time")
        self.process.stdin.write(command + "\n")
        self.process.stdin.flush()

    def stop(self):
        if not self.process or self.process.poll() is not None:
            return
        try:
            self.command("quit")
            self.process.wait(timeout=45)
        except (subprocess.TimeoutExpired, BrokenPipeError):
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()
        self.process.stdin.close()

    def request(self, request):
        action = request["action"]
        if action == "status":
            return {"running": self.process is not None and self.process.poll() is None,
                    "maintenance_in_seconds": max(0, int(self.maintenance_at - time.monotonic()))
                    if self.maintenance_at else None}
        if action == "command":
            self.command(request["command"])
            return "Command sent; output is in docker compose logs"
        if action == "restart":
            self.stop()
            self.settings = read_settings()
            self.start()
            return "Restarted; use update to apply component/configuration changes"
        if action == "update":
            self.maintenance_at = time.monotonic()
            return "Maintenance queued; configured warning period applies"
        raise ValueError("Unknown action")

    def shutdown(self, *_):
        self.stopping = True

    def read_console(self, selector):
        block = os.read(sys.stdin.fileno(), 4096)
        if not block:
            selector.unregister(sys.stdin)
            return
        self.console_buffer += block
        if len(self.console_buffer) > 16384:
            self.console_buffer = b""
            print("Console input exceeded 16 KiB", flush=True)
            return
        while b"\n" in self.console_buffer:
            line, self.console_buffer = self.console_buffer.split(b"\n", 1)
            command = line.decode("utf-8", errors="replace").strip()
            if not command:
                continue
            if command == "quit":
                self.stopping = True
                return
            if command == "cs2kz_update":
                print(self.request({"action": "update"}), flush=True)
                continue
            self.command(command)

    def run(self):
        signal.signal(signal.SIGTERM, self.shutdown)
        signal.signal(signal.SIGINT, self.shutdown)
        install(self.settings)
        if self.stopping:
            return
        SOCKET.parent.mkdir(parents=True, exist_ok=True)
        SOCKET.unlink(missing_ok=True)
        with socket.socket(socket.AF_UNIX) as listener, selectors.DefaultSelector() as selector:
            listener.bind(str(SOCKET))
            SOCKET.chmod(0o600)
            listener.listen(4)
            selector.register(listener, selectors.EVENT_READ, "control")
            if PTERODACTYL and (sys.stdin.isatty() or stat.S_ISFIFO(os.fstat(sys.stdin.fileno()).st_mode)):
                os.set_blocking(sys.stdin.fileno(), False)
                selector.register(sys.stdin, selectors.EVENT_READ, "console")
            self.start()
            try:
                while not self.stopping:
                    if self.process.poll() is not None:
                        raise RuntimeError("Game process exited: " + str(self.process.returncode))
                    for key, _ in selector.select(timeout=1):
                        if key.data == "console":
                            self.read_console(selector)
                            continue
                        connection, _ = listener.accept()
                        with connection:
                            connection.settimeout(3)
                            try:
                                payload = b""
                                while b"\n" not in payload:
                                    block = connection.recv(4096)
                                    if not block or len(payload) + len(block) > 16384:
                                        raise ValueError("Invalid control request")
                                    payload += block
                                result = {"ok": True, "result": self.request(json.loads(payload))}
                            except Exception as error:
                                result = {"ok": False, "error": str(error)}
                            try:
                                connection.sendall(json.dumps(result).encode() + b"\n")
                            except OSError:
                                pass
                    if self.stopping:
                        break
                    now = time.monotonic()
                    if self.maintenance_at and now >= self.maintenance_at and self.update_at is None:
                        warning = read_settings()["maintenance"]["warning_seconds"]
                        self.command("say Server maintenance in " + str(warning) + " seconds")
                        self.update_at = now + warning
                    if self.update_at is not None and now >= self.update_at:
                        self.stop()
                        self.settings = read_settings()
                        install(self.settings)
                        if not self.stopping:
                            self.start()
            finally:
                self.stop()
                SOCKET.unlink(missing_ok=True)


if __name__ == "__main__":
    os.umask(0o077)
    Server().run()

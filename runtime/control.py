import json
import re
import socket
import sys
from paths import SERVER, SOCKET, STATE


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "versions":
        records = {}
        for path in STATE.glob("*.json"):
            record = json.loads(path.read_text())
            records[path.stem] = {key: record[key] for key in ["resolved", "download_sha256"]}
        manifest = (SERVER / "steamapps/appmanifest_730.acf").read_text()
        build = re.search(r'"buildid"\s+"(\d+)"', manifest)
        if not build:
            raise ValueError("Cannot find installed Steam build")
        print(json.dumps({"build": build[1], "components": records}, indent=2))
        return
    request = {"action": "status" if action == "health" else action}
    if action == "command":
        request["command"] = " ".join(sys.argv[2:])
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(10)
        connection.connect(str(SOCKET))
        connection.sendall(json.dumps(request).encode() + b"\n")
        response = b""
        while b"\n" not in response:
            block = connection.recv(4096)
            if not block:
                raise RuntimeError("Control socket closed without a response")
            response += block
    result = json.loads(response)
    if not result["ok"]:
        raise RuntimeError(result["error"])
    if action == "health":
        if not result["result"]["running"]:
            raise RuntimeError("Game is not running")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as query:
            query.settimeout(3)
            from settings import read_settings
            query.sendto(b"\xff\xff\xff\xffTSource Engine Query\x00", ("127.0.0.1", read_settings()["game"]["port"]))
            packet = query.recv(65535)
            if not packet.startswith((b"\xff\xff\xff\xffI", b"\xff\xff\xff\xffA")):
                raise RuntimeError("Game did not answer an A2S query")
        return
    print(json.dumps(result["result"], indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

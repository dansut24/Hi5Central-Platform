"""Windows CI smoke test for actual native-messaging STDIO framing (no elevation)."""
import json
import struct
import subprocess
import sys

host = sys.argv[1]
origin = "chrome-extension://mdablcgpimddfidkjilfglpcaolpopda/"
body = json.dumps({"type": "request", "path": r"C:\Windows\System32\cmd.exe"}).encode()
wire = struct.pack("<I", len(body)) + body
result = subprocess.run(
    [host, origin], input=wire, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    timeout=12, check=False
)
assert result.returncode == 0, result.returncode
assert len(result.stdout) >= 4, "Missing framed host output"
length = struct.unpack("<I", result.stdout[:4])[0]
assert length == len(result.stdout) - 4, "Response length mismatch"
parsed = json.loads(result.stdout[4:])
assert parsed["ok"] is False, "Untrusted system binary was accepted"
assert "C:\\Windows" not in result.stdout.decode(errors="replace"), "File path leaked"
assert result.stderr == b"", "Native host printed to stderr in routine rejection"
print("PASS: actual Windows native host STDIO exchange, restricted-path rejection")

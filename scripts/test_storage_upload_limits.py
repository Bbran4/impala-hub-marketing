"""Check the real Storage HTTP API in the disposable local Supabase CI stack."""
import base64
import json
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid

if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("This test runs only in the disposable GitHub Actions Supabase stack.")

settings = json.loads(subprocess.check_output(["supabase", "status", "--output", "json"], text=True))
origin = settings["API_URL"].rstrip("/")
if urllib.parse.urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
    raise SystemExit("Storage upload tests must target the local disposable stack.")
token = settings["SERVICE_ROLE_KEY"]
prefix = "storage-limits-test/" + str(uuid.uuid4())
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=")


def request(method, route, body, content_type, upsert=False):
    headers = {"Authorization": "Bearer " + token, "apikey": token, "Content-Type": content_type}
    if upsert:
        headers["x-upsert"] = "true"
    req = urllib.request.Request(origin + "/storage/v1/" + route, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


for bucket, megabytes in (("marketing-media", 15), ("profile-avatars", 15),
                          ("sales-desk-attachments", 15), ("chat-attachments", 25)):
    path = prefix + "/boundary.png"
    limit = megabytes * 1024 * 1024
    try:
        # Use the service credential to bypass RLS: rejection must come from
        # Storage's bucket configuration, not a missing business-record permission.
        status, result = request("POST", "object/" + bucket + "/" + path,
                                 png + b"\0" * (limit - len(png)), "image/png")
        assert status == 200, (bucket, "valid boundary upload", status, result)
        for upsert in (False, True):
            target = path if upsert else prefix + "/rejected.png"
            status, result = request("POST", "object/" + bucket + "/" + target,
                                     b"x" * (limit + 1), "image/png", upsert)
            assert status in (400, 413) and any(term in result.lower() for term in ("size", "large", "exceed")), (bucket, "oversize", status, result)
            status, result = request("POST", "object/" + bucket + "/" + target,
                                     b"<svg></svg>", "image/svg+xml", upsert)
            assert status in (400, 415) and "mime" in result.lower(), (bucket, "unsupported type", status, result)
        print(bucket + ": exact size boundary accepted; oversized/disallowed uploads and overwrites rejected")
    finally:
        status, result = request("DELETE", "object/" + bucket,
                                 json.dumps({"prefixes": [path, prefix + "/rejected.png"]}).encode(), "application/json")
        assert status == 200, (bucket, "cleanup", status, result)

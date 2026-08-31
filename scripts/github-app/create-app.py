#!/usr/bin/env python3
"""
Create a GitHub App on an org from a manifest, and capture its credentials.

GitHub has NO REST endpoint that creates an App. The only programmatic path is the
"app manifest flow", which still needs a browser session authenticated as an org owner.
This script automates every part of that flow except the click:

  1. serves a local page that POSTs the manifest to GitHub
  2. you review + confirm on github.com (the one manual step)
  3. GitHub redirects back here with a short-lived `code`
  4. the code is exchanged for the App id, private key (PEM), webhook secret, client id/secret
  5. credentials are written OUTSIDE the repo, mode 0600

The `code` expires in one hour and is single-use.

Usage:
    python3 scripts/github-app/create-app.py gaiada-erp.manifest.json --org gaiadabali

Then, separately and in the browser, INSTALL the app on the org. Creation != installation;
the installation id is what mints tokens, and this script prints where to get it.
"""

import argparse
import http.server
import json
import os
import pathlib
import socketserver
import sys
import threading
import urllib.error
import urllib.request
import webbrowser

PORT = 8765
OUT_DIR = pathlib.Path.home() / ".gaiada-secrets" / "github-apps"

_result = {}
_done = threading.Event()


class Handler(http.server.BaseHTTPRequestHandler):
    manifest_json = ""
    org = ""

    def log_message(self, *_args):
        pass  # keep the console clean; we print our own progress

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/callback"):
            return self._callback()
        if self.path == "/" or self.path.startswith("/start"):
            return self._start()
        self._send(404, "<h1>404</h1>")

    def _start(self):
        # A self-submitting form is the documented way to hand a manifest to GitHub:
        # it must arrive as a form POST, not a redirect or an XHR.
        action = f"https://github.com/organizations/{self.org}/settings/apps/new"
        self._send(
            200,
            f"""<!doctype html><meta charset="utf-8">
<title>Creating GitHub App…</title>
<body style="font-family:system-ui;padding:3rem;max-width:40rem;margin:auto">
<h2>Handing the manifest to GitHub…</h2>
<p>If nothing happens, press the button.</p>
<form id="f" method="post" action="{action}">
  <input type="hidden" name="manifest" id="m">
  <button type="submit">Continue to GitHub</button>
</form>
<script>
  document.getElementById("m").value = {json.dumps(self.manifest_json)};
  document.getElementById("f").submit();
</script>
</body>""",
        )

    def _callback(self):
        qs = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(
            (k, v)
            for k, _, v in (p.partition("=") for p in qs.split("&") if p)
        )
        code = params.get("code")
        if not code:
            self._send(400, "<h1>No <code>code</code> in callback.</h1>")
            _result["error"] = "no code in callback"
            _done.set()
            return
        try:
            _result["data"] = exchange(code)
            self._send(
                200,
                "<h2>Done — credentials written.</h2>"
                "<p>Return to the terminal. You can close this tab.</p>",
            )
        except Exception as exc:  # surfaced in the terminal, not swallowed
            _result["error"] = repr(exc)
            self._send(500, f"<h2>Exchange failed</h2><pre>{exc}</pre>")
        _done.set()


def exchange(code):
    req = urllib.request.Request(
        f"https://api.github.com/app-manifests/{code}/conversions",
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "gaiada-app-bootstrap",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def write_credentials(data):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(OUT_DIR, 0o700)
    slug = data["slug"]

    pem_path = OUT_DIR / f"{slug}.private-key.pem"
    pem_path.write_text(data["pem"], encoding="utf-8")
    os.chmod(pem_path, 0o600)

    meta = {
        "app_id": data["id"],
        "slug": slug,
        "name": data["name"],
        "owner": data.get("owner", {}).get("login"),
        "client_id": data.get("client_id"),
        "client_secret": data.get("client_secret"),
        "webhook_secret": data.get("webhook_secret"),
        "html_url": data.get("html_url"),
        "pem_file": str(pem_path),
        "installation_id": None,  # filled in AFTER you install the app on the org
    }
    meta_path = OUT_DIR / f"{slug}.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    os.chmod(meta_path, 0o600)
    return meta, pem_path, meta_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", help="path to a *.manifest.json file")
    ap.add_argument("--org", required=True, help="GitHub org login, e.g. gaiadabali")
    args = ap.parse_args()

    manifest_path = pathlib.Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path = pathlib.Path(__file__).parent / manifest_path
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    redirect = manifest.get("redirect_url", "")
    if f":{PORT}" not in redirect:
        sys.exit(
            f"manifest redirect_url must point at http://localhost:{PORT}/callback "
            f"(found: {redirect!r})"
        )

    Handler.manifest_json = json.dumps(manifest)
    Handler.org = args.org

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        url = f"http://localhost:{PORT}/start"
        print(f"App:  {manifest['name']}")
        print(f"Org:  {args.org}")
        print(f"\nOpen this if a browser does not appear:\n  {url}\n")
        print("You must be signed in to GitHub as an OWNER of the org.")
        webbrowser.open(url)

        if not _done.wait(timeout=600):
            sys.exit("timed out after 10 minutes waiting for the GitHub callback")
        httpd.shutdown()

    if "error" in _result:
        sys.exit(f"failed: {_result['error']}")

    meta, pem_path, meta_path = write_credentials(_result["data"])
    print("\n  App created.")
    print(f"  app_id       {meta['app_id']}")
    print(f"  slug         {meta['slug']}")
    print(f"  private key  {pem_path}")
    print(f"  metadata     {meta_path}")
    print(f"\n  NEXT — install it on the org (creation is not installation):")
    print(f"    {meta['html_url']}/installations/new")
    print(f"  Then read the installation id from the URL you land on")
    print(f"  (.../settings/installations/<INSTALLATION_ID>) and put it in")
    print(f"  {meta_path} under \"installation_id\".")


if __name__ == "__main__":
    main()

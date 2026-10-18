# Post one line in a contestant's Kick chat: python kick_say.py <stock name> <message>
# Auth: KICK_BEARER (URL-decoded Kick session_token cookie), set in .env by import-cookies.mjs and passed
# down by the engine. Kick blocks Node's TLS fingerprint, hence Python + curl_cffi (browser impersonation).
import json, os, sys
from curl_cffi import requests

name, msg = sys.argv[1], sys.argv[2]
bearer = os.environ["KICK_BEARER"]
slug = name.lower().replace("_", "-")
s = requests.Session(impersonate="chrome136")
h = {"Accept": "application/json", "Content-Type": "application/json", "Authorization": f"Bearer {bearer}",
     "Origin": "https://kick.com", "Referer": f"https://kick.com/{slug}"}
r = s.get(f"https://kick.com/api/v2/channels/{slug}", headers=h, timeout=15)
room = (r.json().get("chatroom") or {}).get("id") if r.status_code == 200 else None
if not room:
    sys.exit(print(json.dumps({"slug": slug, "status": r.status_code, "err": "no chatroom"})))
r = s.post(f"https://kick.com/api/v2/messages/send/{room}", headers=h, json={"content": msg, "type": "message"}, timeout=15)
print(json.dumps({"slug": slug, "status": r.status_code, "body": r.text[:120]}))

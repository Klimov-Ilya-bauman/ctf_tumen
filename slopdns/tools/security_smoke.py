#!/usr/bin/env python3
"""Destructive test data only: creates three NEW users/orgs in a LOCAL test service."""
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18080"
if not BASE.startswith(("http://127.0.0.1:", "http://localhost:")):
    raise SystemExit("Use a disposable local test deployment only")
TAG = uuid.uuid4().hex[:10]


class Client:
    def __init__(self, label):
        self.username = label + TAG
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.user = self.call("POST", "/auth/register", {"username": self.username, "password": "audit-only-" + TAG}, 201)
        self.call("POST", "/auth/login", {"username": self.username, "password": "audit-only-" + TAG})
        self.org = self.call("POST", "/orgs", {"name": self.username}, 201)["id"]

    def call(self, method, path, data=None, status=200):
        raw = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(BASE + "/api/v1" + path, data=raw, method=method,
                                     headers={"Content-Type": "application/json", "X-SlopDNS-CSRF": "1"})
        try:
            res = self.http.open(req, timeout=15)
        except urllib.error.HTTPError as err:
            res = err
        body = res.read()
        assert res.code == status, (method, path, res.code, status, body)
        return json.loads(body) if body else None


owner, zone_admin, recipient = (Client(label) for label in ("owner", "admin", "recv"))
zone = owner.call("POST", "/zones", {"org_id": owner.org, "name": "audit" + TAG + ".slop."}, 201)
zid = zone["id"]
invite = owner.call("POST", "/orgs/" + owner.org + "/invitations", {"username": zone_admin.username, "role": "reader"}, 201)
zone_admin.call("POST", "/invitations/" + invite["id"] + "/accept")
binding = owner.call("POST", "/role-bindings", {"username": zone_admin.username, "resource_type": "zone", "resource_id": zid, "role": "admin"}, 201)
for b in owner.call("GET", "/role-bindings?resource_type=org&resource_id=" + owner.org)["items"]:
    if b["principal_id"] == zone_admin.user["id"]:
        owner.call("DELETE", "/role-bindings/" + b["id"], status=204)
zone_admin.call("GET", "/zones/" + zid)
zone_admin.call("PATCH", "/orgs/" + owner.org, {"name": "forbidden" + TAG}, 403)
zone_admin.call("POST", "/role-bindings", {"username": zone_admin.username, "resource_type": "org", "resource_id": owner.org, "role": "admin"}, 403)
zone_admin.call("POST", "/service-accounts", {"org_id": owner.org, "name": "forbidden"}, 403)
# The recipient owns an unrelated org. That must not authorize the destination.
transfer = zone_admin.call("POST", "/zones/" + zid + "/transfer", {"username": recipient.username}, 201)
recipient.call("POST", "/zone-transfers/" + transfer["id"] + "/accept", {"target_org_id": zone_admin.org}, 403)
assert owner.call("GET", "/zones/" + zid)["org_id"] == owner.org
assert recipient.call("GET", "/zone-transfers/" + transfer["id"])["status"] == "pending"
recipient.call("POST", "/zone-transfers/" + transfer["id"] + "/accept", {"target_org_id": recipient.org})
assert recipient.call("GET", "/zones/" + zid)["org_id"] == recipient.org
# Ordinary records, including GPT, remain usable after a legitimate transfer.
for typ, data in [("A", {"address": "192.0.2.10"}), ("GPT", {"text": "security regression"})]:
    rec = recipient.call("POST", "/zones/" + zid + "/records", {"name": "test", "type": typ, "data": data}, 201)
    recipient.call("DELETE", "/records/" + rec["id"], status=204)
print("PASS: zone isolation, org/SA escalation denied, foreign transfer denied without mutation, legitimate transfer and A/GPT CRUD")

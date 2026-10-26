// Clean the smoke-test projects out of the studio store.
import fs from "node:fs";

const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const grab = (k, fb) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  if (!m) return fb;
  return m[1].trim().replace(/^["']|["']$/g, "");
};
const BASE = process.env.BASE || "http://localhost:8790";
const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: grab("LOGIN_USER", "admin"), password: grab("LOGIN_PASS", "admin") }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
const call = async (method, path) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", cookie } });
  return { status: r.status, data: await r.json().catch(() => null) };
};

const list = await call("GET", "/api/kids/projects");
for (const p of list.data || []) {
  const res = await call("DELETE", `/api/kids/projects/${p.id}`);
  console.log("deleted", p.id, res.status);
}
console.log("remaining:", (await call("GET", "/api/kids/projects")).data.length);

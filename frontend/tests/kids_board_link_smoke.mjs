// Smoke test: link a real Director board to a Kids project (mirrors the
// storyboard + derives the Director Plan from it).
import fs from "node:fs";

const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
const grab = (k, fb) => {
  const m = env.match(new RegExp(`^${k}=(.*)$`, "m"));
  if (!m) return fb;
  return m[1].trim().replace(/^["']|["']$/g, "");
};
const user = grab("LOGIN_USER", "admin");
const pass = grab("LOGIN_PASS", "admin");
const BASE = process.env.BASE || "http://localhost:8790";

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: user, password: pass }),
});
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};

const created = await call("POST", "/api/kids/projects", {
  title: "Doggy Morning",
  script: "Doggy wakes up, greets his friends and plays in the park all morning.",
  language: "Hindi",
  category: "General Kids Entertainment",
  age_group: "4-6 years",
  duration_seconds: 60,
});
console.log("create:", created.status);
const id = created.data.project.id;

const linked = await call("PUT", `/api/kids/projects/${id}/board`, { board_id: "doggy" });
console.log("link board:", linked.status);
console.log("  scenes mirrored:", linked.data.scenes?.length);
console.log("  characters mirrored:", linked.data.characters?.length);
console.log("  plan version:", linked.data.plan?.version, "status:", linked.data.plan?.status);
console.log("  plan creative:", String(linked.data.plan?.plan?.creative_direction).slice(0, 100));

const detail = await call("GET", `/api/kids/projects/${id}`);
console.log("detail:", detail.status, "| scenes:", detail.data.scenes.length, "| chars:", detail.data.characters.length);

const approved = await call("POST", `/api/kids/projects/${id}/plan/approve`, {});
console.log("approve plan:", approved.status, "->", approved.data.plan?.status);

const edited = await call("PUT", `/api/kids/projects/${id}/plan`, {
  plan: { ...detail.data.plan.plan, creative_direction: "shorter" },
});
console.log("edit approved plan without unlock:", edited.status, "->", edited.data.error);

const edited2 = await call("PUT", `/api/kids/projects/${id}/plan`, {
  plan: { ...detail.data.plan.plan, creative_direction: "shorter" },
  unlock: true,
});
console.log("edit approved plan WITH unlock:", edited2.status, "-> v" + edited2.data.plan?.version);

const dash = await call("GET", "/api/kids/dashboard");
console.log("dashboard metrics:", JSON.stringify(dash.data.metrics));

await call("DELETE", `/api/kids/projects/${id}`);
console.log("cleanup done");

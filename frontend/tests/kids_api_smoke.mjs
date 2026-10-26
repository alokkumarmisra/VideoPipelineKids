// Smoke test for the Sanskriti Kids API (dev helper, not part of the app).
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
console.log("login:", login.status);

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

const show = (label, res, limit = 700) => {
  console.log(`\n--- ${label} [${res.status}]`);
  console.log(JSON.stringify(res.data).slice(0, limit));
};

show("health", await call("GET", "/api/kids/health"));
show("options", await call("GET", "/api/kids/options"));
show("dashboard", await call("GET", "/api/kids/dashboard"));

const created = await call("POST", "/api/kids/projects", {
  title: "A for Apple",
  description: "Alphabet song for preschoolers",
  language: "Hindi",
  category: "Alphabet and Phonics",
  age_group: "2-4 years",
  duration_seconds: 60,
  aspect_ratio: "16:9",
  resolution: "1280x720",
  visual_style: "3D Preschool Animation",
  narration_preferences: "friendly female Hindi voice",
  music_preferences: "light ukulele",
  target_platform: "YouTube Kids",
  script: "A for Apple, B for Ball. C for Cat, D for Duck. E for Elephant, F for Fish.",
});
show("create project", created, 900);

if (created.status === 200) {
  const id = created.data.project.id;
  show("project detail", await call("GET", `/api/kids/projects/${id}`), 900);
  show("dashboard after create", await call("GET", "/api/kids/dashboard"), 700);
  show("update project", await call("PUT", `/api/kids/projects/${id}`, {
    description: "Alphabet song for preschoolers (edited)",
  }), 500);
  show("plan (llm)", await call("POST", `/api/kids/projects/${id}/plan`, {}), 500);
  show("delete project", await call("DELETE", `/api/kids/projects/${id}`), 200);
}

import { useEffect, useMemo, useState } from "react";
import {
  getDirectorPromptSettings,
  saveDirectorPromptSettings,
  type DirectorPromptSettings,
  type DirectorPromptSettingsRule,
} from "../api";

const defaultSettings = (catalog: DirectorPromptSettingsRule[]): DirectorPromptSettings => ({
  rules: Object.fromEntries(catalog.map((rule) => [rule.id, { enabled: rule.defaultEnabled, text: rule.defaultText }])),
  custom: { enabled: false, text: "" },
});

const workflows = [
  { id: "director", title: "AI Director", description: "Story and song scene planning, repair, and regeneration." },
  { id: "kids", title: "Sanskriti Kids Director", description: "Kids Director Plan scenes." },
  { id: "documentary", title: "Documentary Director", description: "Documentary shot planning." },
] as const;

function previewText(catalog: DirectorPromptSettingsRule[], settings: DirectorPromptSettings, scope: typeof workflows[number]["id"]) {
  const blocks = catalog
    .filter((rule) => rule.scope === scope && settings.rules[rule.id]?.enabled && settings.rules[rule.id]?.text.trim())
    .map((rule) => `${rule.title.toUpperCase()}:\n${settings.rules[rule.id].text.trim()}`);
  if (settings.custom.enabled && settings.custom.text.trim()) {
    blocks.push(`CUSTOM DIRECTOR INSTRUCTIONS:\n${settings.custom.text.trim()}`);
  }
  return blocks.length ? `OPTIONAL PROMPT ADD-ONS (selected in Prompt Settings):\n${blocks.join("\n\n")}` : "";
}

export default function PromptSettingsPage() {
  const [catalog, setCatalog] = useState<DirectorPromptSettingsRule[]>([]);
  const [settings, setSettings] = useState<DirectorPromptSettings>({ rules: {}, custom: { enabled: false, text: "" } });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getDirectorPromptSettings()
      .then((response) => {
        if (cancelled) return;
        setCatalog(response.catalog);
        setSettings(response.settings);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const appendedByWorkflow = useMemo(() => Object.fromEntries(
    workflows.map((workflow) => [workflow.id, previewText(catalog, settings, workflow.id)]),
  ) as Record<typeof workflows[number]["id"], string>, [catalog, settings]);
  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await saveDirectorPromptSettings(settings);
      setCatalog(response.catalog);
      setSettings(response.settings);
      setMessage("Prompt settings saved. They will apply to the next scene plan, repair, or regeneration.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const restoreDefaults = () => setSettings(defaultSettings(catalog));

  return (
    <main className="col" style={{ maxWidth: 1100, margin: "0 auto", width: "100%" }}>
      <section className="card">
        <div className="card-head">
          <div>
          <h1 style={{ margin: 0 }}>Prompt Settings</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              Choose reusable instructions by workflow. Each checkbox controls the text appended to that workflow's scene or shot planning prompt. Required output formats, asset grounding, and safety rules stay active.
            </p>
          </div>
        </div>
        <div className="row" style={{ gap: 8, margin: "12px 0" }}>
          <button className="primary" onClick={() => void save()} disabled={loading || saving}>
            {saving ? "Saving…" : "Save prompt settings"}
          </button>
          <button className="ghost" onClick={restoreDefaults} disabled={loading || saving}>Restore defaults</button>
          {message && <span className="muted" role="status">{message}</span>}
          {error && <span className="err-text" role="alert">{error}</span>}
        </div>
        {loading ? <p className="muted">Loading prompt settings…</p> : (
          <div style={{ display: "grid", gap: 18 }}>
            {workflows.map((workflow) => (
              <section key={workflow.id}>
                <div style={{ marginBottom: 8 }}>
                  <h2 style={{ margin: 0 }}>{workflow.title}</h2>
                  <p className="muted" style={{ margin: "4px 0 0", fontSize: 12 }}>{workflow.description}</p>
                </div>
                <div style={{ display: "grid", gap: 10 }}>
            {catalog.filter((item) => item.scope === workflow.id).map((rule) => {
              const value = settings.rules[rule.id] || { enabled: rule.defaultEnabled, text: rule.defaultText };
              return (
                <article className="card" key={rule.id} style={{ margin: 0, padding: 14 }}>
                  <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={value.enabled}
                      onChange={(event) => setSettings((current) => ({
                        ...current,
                        rules: { ...current.rules, [rule.id]: { ...value, enabled: event.target.checked } },
                      }))}
                    />
                    <span>
                      <b>{rule.title}</b>
                      <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 3 }}>{rule.description}</span>
                    </span>
                  </label>
                  <label className="muted" style={{ display: "block", margin: "10px 0 4px", fontSize: 11 }}>
                    Text appended when checked
                  </label>
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={value.text}
                    onChange={(event) => setSettings((current) => ({
                      ...current,
                      rules: { ...current.rules, [rule.id]: { ...value, text: event.target.value } },
                    }))}
                    aria-label={`${rule.title} appended text`}
                  />
                </article>
              );
            })}
                </div>
              </section>
            ))}
            <article className="card" style={{ margin: 0, padding: 14 }}>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.custom.enabled}
                  onChange={(event) => setSettings((current) => ({ ...current, custom: { ...current.custom, enabled: event.target.checked } }))}
                />
                <span><b>Custom prompt instructions</b><span className="muted" style={{ display: "block", fontSize: 12, marginTop: 3 }}>Append this text to all three scene and shot planning workflows.</span></span>
              </label>
              <label className="muted" style={{ display: "block", margin: "10px 0 4px", fontSize: 11 }}>Custom text appended when checked</label>
              <textarea
                rows={4}
                maxLength={4000}
                value={settings.custom.text}
                placeholder="Write additional directing instructions…"
                onChange={(event) => setSettings((current) => ({ ...current, custom: { ...current.custom, text: event.target.value } }))}
                aria-label="Custom prompt instructions"
              />
            </article>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h2 style={{ margin: 0 }}>Exact appended prompt text</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>This preview updates immediately as you toggle or edit options. It separates the exact text by workflow.</p>
        {workflows.map((workflow) => (
          <div key={workflow.id} style={{ marginTop: 12 }}>
            <b>{workflow.title}</b>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 360, overflow: "auto", padding: 14, borderRadius: 8, background: "var(--inset)", color: "var(--text)" }}>
              {appendedByWorkflow[workflow.id] || "No optional text will be appended. Required schema, asset-reference, and safety instructions remain active."}
            </pre>
          </div>
        ))}
      </section>
    </main>
  );
}

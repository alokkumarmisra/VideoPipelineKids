import { useEffect, useState } from "react";
import { directorAssets, directorAssetFileUrl, type DirectorAssetProduction } from "../api";
import type { DirectorMasterAsset } from "../api";

const GROUPS: { type: DirectorMasterAsset["type"]; label: string }[] = [
  { type: "character", label: "Characters" },
  { type: "location", label: "Locations & Worlds" },
  { type: "object", label: "Objects & Props" },
];

/** Read-only view of the canonical Director assets linked to a project. */
export default function DirectorProjectAssets({ boardId }: { boardId?: string | null }) {
  const [production, setProduction] = useState<DirectorAssetProduction | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!boardId) {
      setProduction(null);
      setError("");
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const result = await directorAssets(boardId);
        if (!cancelled) {
          setProduction(result.production ?? null);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    setProduction(null);
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [boardId]);

  if (!boardId) return null;
  const assets = production?.assets ?? [];
  const ready = assets.filter((asset) => Boolean(asset.reference)).length;

  return (
    <section className="card director-project-assets" aria-label="Director characters and world assets">
      <div className="card-head">
        <h2>🌍 Characters &amp; World</h2>
        <span className="pill">Images {ready}/{assets.length}</span>
        <span className="spacer" />
        <span className="muted">Director {boardId.replace(/^DIRECTOR_/i, "D")}</span>
      </div>
      {error ? <p className="hint">Unable to load Director assets: {error}</p> : null}
      {loading && assets.length === 0 ? <p className="hint">Loading linked assets…</p> : null}
      {!loading && assets.length === 0 && !error ? <p className="hint">No character, location, or object assets are linked to this project.</p> : null}
      {GROUPS.map((group) => {
        const items = assets.filter((asset) => asset.type === group.type);
        if (items.length === 0) return null;
        return (
          <div className="director-project-asset-group" key={group.type}>
            <div className="section-label">{group.label} · {items.length}</div>
            <div className="director-project-asset-grid">
              {items.map((asset) => (
                <article className="director-project-asset" key={asset.id}>
                  <div className="director-project-asset-image">
                    {asset.reference ? (
                      <img src={directorAssetFileUrl(asset.reference)} alt={`${asset.name} reference`} loading="lazy" />
                    ) : (
                      <span>{asset.status === "generating" || asset.status === "queued" ? "Generating image…" : "No reference image"}</span>
                    )}
                  </div>
                  <div className="director-project-asset-name" title={asset.name}>{asset.name}</div>
                  <div className="muted director-project-asset-meta" title={`${asset.reference_id || asset.id} · ${asset.status}`}>
                    {asset.reference_id || asset.id} · {asset.reference ? `v${asset.version}` : asset.status}
                  </div>
                  {asset.description ? <p className="director-project-asset-description">{asset.description}</p> : null}
                </article>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

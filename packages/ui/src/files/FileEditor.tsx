import { useEffect, useState } from "react";
import type { WebDavClient } from "./webdav.js";

type SaveState = "idle" | "saving" | "saved" | "failed";

export function FileEditor({
  client,
  path,
  onClose,
}: {
  client: WebDavClient;
  path: string;
  onClose: () => void;
}): React.JSX.Element {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    setSaveState("idle");
    void client.read(path).then(
      (text) => {
        if (!active) return;
        setContent(text);
        setLoading(false);
      },
      (error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "File load failed.");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [client, path]);

  const save = async (): Promise<void> => {
    if (saveState === "saving") return;
    setSaveState("saving");
    try {
      setSaveState((await client.put(path, content)) ? "saved" : "failed");
    } catch {
      setSaveState("failed");
    }
  };

  return (
    <section className="file-editor" aria-label={`Editing ${path}`}>
      <div className="section-heading">
        <h3>{path}</h3>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {loading && <p className="loading-state">Loading file…</p>}
      {loadError !== null && <p className="form-error">{loadError}</p>}
      {!loading && loadError === null && (
        <>
          <textarea
            aria-label="File contents"
            value={content}
            spellCheck={false}
            onChange={(event) => {
              setContent(event.currentTarget.value);
              setSaveState("idle");
            }}
          />
          <footer className="editor-footer">
            <span>concurrent saves are last-write-wins.</span>
            <span className={saveState === "failed" ? "form-error" : "muted"}>
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "failed" ? "Save failed" : "Unsaved"}
            </span>
            <button className="primary" type="button" disabled={saveState === "saving"} onClick={() => void save()}>Save</button>
          </footer>
        </>
      )}
    </section>
  );
}

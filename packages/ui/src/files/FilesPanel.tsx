import { useEffect, useMemo, useState } from "react";
import { endpointTarget } from "../resolver.js";
import { FileEditor } from "./FileEditor.js";
import { joinPath, MAX_UPLOAD_BYTES, parentPath, WebDavClient, type WebDavEntry } from "./webdav.js";

export function FilesPanel({ baseUrl }: { baseUrl: string }): React.JSX.Element {
  const needsOwnOrigin = new URL(baseUrl, window.location.href).origin !== window.location.origin;
  const client = useMemo(() => new WebDavClient(baseUrl), [baseUrl]);
  const [directory, setDirectory] = useState("/");
  const [entries, setEntries] = useState<WebDavEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await client.list(directory));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Directory listing failed.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (needsOwnOrigin) return;
    setSelected(null);
    void refresh();
    // `client` changes with the endpoint and `directory` is the requested WebDAV path.
  }, [client, directory, needsOwnOrigin]);

  const mkdir = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await client.mkdir(joinPath(directory, folderName));
      setFolderName("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create folder failed.");
    }
  };

  const upload = async (files: FileList | null): Promise<void> => {
    if (files === null) return;
    const selectedFiles = [...files];
    if (selectedFiles.some(({ size }) => size > MAX_UPLOAD_BYTES)) {
      setNotice("Upload refused: files must be 32 MiB or smaller.");
      return;
    }
    setNotice("Uploading…");
    for (const file of selectedFiles) {
      if (!(await client.put(joinPath(directory, file.name), file))) {
        setNotice(`Upload failed: ${file.name}`);
        return;
      }
    }
    setNotice("Upload complete.");
    await refresh();
  };

  const remove = async (entry: WebDavEntry): Promise<void> => {
    if (!window.confirm(`Delete ${entry.name}?`)) return;
    try {
      await client.remove(entry.path);
      if (selected === entry.path) setSelected(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed.");
    }
  };

  const rename = async (entry: WebDavEntry): Promise<void> => {
    const name = window.prompt("New name", entry.name);
    if (name === null || name === entry.name) return;
    try {
      await client.move(entry.path, joinPath(directory, name));
      if (selected === entry.path) setSelected(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Rename failed.");
    }
  };

  if (needsOwnOrigin) {
    return (
      <section className="panel files-frame-panel">
        <div className="panel-toolbar"><code className="endpoint-target">{endpointTarget(baseUrl)}</code></div>
        <iframe src={baseUrl} title="Files" />
      </section>
    );
  }

  return (
    <section className="panel files-panel">
      <aside className="files-sidebar">
        <div className="panel-toolbar">
          <button className="cockpit-action" type="button" disabled={directory === "/"} onClick={() => setDirectory(parentPath(directory))}>Up</button>
          <strong>{directory}</strong>
          <code className="endpoint-target">{endpointTarget(baseUrl)}</code>
          <button className="cockpit-action" type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
        <form className="inline-form" onSubmit={(event) => void mkdir(event)}>
          <input aria-label="New folder name" value={folderName} placeholder="New folder" onChange={(event) => setFolderName(event.currentTarget.value)} />
          <button className="cockpit-action" type="submit" disabled={folderName.trim().length === 0}>Make</button>
        </form>
        <label className="upload-button">
          Upload
          <input type="file" multiple onChange={(event) => void upload(event.currentTarget.files)} />
        </label>
        {notice !== null && <p className="muted">{notice}</p>}
        {loading && <p className="loading-state has-spinner">Loading files…</p>}
        {error !== null && <p className="cockpit-form-message form-error">{error}</p>}
        <div className="file-list">
          {entries.map((entry) => (
            <div className="file-row" key={entry.path}>
              <button
                className="cockpit-action file-name"
                type="button"
                onClick={() => entry.directory ? setDirectory(entry.path) : setSelected(entry.path)}
              >
                <span>{entry.directory ? "▸" : "·"} {entry.name}</span>
                {!entry.directory && entry.size !== null && <small>{entry.size} B</small>}
              </button>
              <button className="cockpit-action" type="button" aria-label={`Rename ${entry.name}`} onClick={() => void rename(entry)}>Rename</button>
              <button className="cockpit-action" type="button" aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}>Delete</button>
            </div>
          ))}
        </div>
      </aside>
      <div className="file-editor-pane">
        {selected === null
          ? <div className="cockpit-empty">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M6 5h8l3 4h9v18H6z" />
                <path d="M6 11h20" />
              </svg>
              <h1>No file selected</h1>
              <p>Select a file to view or edit it.</p>
            </div>
          : <FileEditor key={selected} client={client} path={selected} onClose={() => setSelected(null)} />}
      </div>
    </section>
  );
}

import { previewUrl } from './preview';

export function PreviewPanel({
  port,
  filesBase,
  running,
}: {
  port: number;
  filesBase: string | null;
  running: boolean;
}) {
  if (!running || !filesBase) {
    return <div className="preview-panel__asleep">Box is asleep</div>;
  }
  const url = previewUrl(filesBase, port);
  return (
    <div className="preview-panel">
      <iframe
        src={url}
        title={`Preview :${port}`}
        referrerPolicy="no-referrer"
      />
      <button
        className="preview-panel__open"
        type="button"
        onClick={() => window.open(url, '_blank', 'noopener')}
      >
        open ↗
      </button>
    </div>
  );
}

import { isEmbeddablePreviewUrl, previewLinkLabel, previewUrl } from './preview';
import { isNumber } from './type-guards';

export function PreviewPanel({
  target,
  path,
  filesBase,
  running,
}: {
  target: number | { url: string; title: string };
  path?: string;
  filesBase: string | null;
  running: boolean;
}) {
  const local = isNumber(target);
  if (local && (!running || !filesBase)) {
    return <div className="preview-panel__asleep">Box is asleep</div>;
  }
  const url = local ? previewUrl(filesBase ?? '', target, path ?? '/') : target.url;
  const title = local
    ? `Preview :${target}`
    : previewLinkLabel(target.url, target.title);
  if (!local && !isEmbeddablePreviewUrl(url)) {
    return (
      <div className="preview-panel preview-panel--external">
        <div className="preview-panel__external-card">
          <strong>{title}</strong>
          <span>{url}</span>
          <a href={url} target="_blank" rel="noopener">Open in new tab ↗</a>
        </div>
      </div>
    );
  }
  return (
    <div className="preview-panel">
      <iframe
        src={url}
        title={title}
        referrerPolicy="no-referrer"
      />
      <a
        className="preview-panel__open"
        href={url}
        target="_blank"
        rel="noopener"
      >
        open ↗
      </a>
    </div>
  );
}

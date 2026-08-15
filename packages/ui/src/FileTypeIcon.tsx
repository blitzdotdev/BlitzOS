import { getIconForFilePath, type MaterialIcon } from 'vscode-material-icons';

const iconAssets = import.meta.glob([
  '../../../node_modules/vscode-material-icons/generated/icons/*.svg',
  '!../../../node_modules/vscode-material-icons/generated/icons/file.svg',
  '!../../../node_modules/vscode-material-icons/generated/icons/folder*.svg',
], {
  eager: true,
  import: 'default',
  query: '?url&no-inline',
}) as Record<string, string>;

const iconUrls = new Map(Object.entries(iconAssets).map(([path, url]) => [
  path.slice(path.lastIndexOf('/') + 1, -'.svg'.length),
  url,
]));

export function materialFileIconName(filePath: string): MaterialIcon | null {
  const normalizedPath = filePath.toLowerCase();
  const fileName = normalizedPath.split('/').at(-1);
  const iconName = fileName === 'package.json'
    ? 'npm'
    : getIconForFilePath(normalizedPath);
  return iconName === 'file' ? null : iconName;
}

export function FileTypeIcon({
  className = '',
  filePath,
}: {
  className?: string;
  filePath: string;
}) {
  const iconName = materialFileIconName(filePath);
  const iconUrl = iconName ? iconUrls.get(iconName) : undefined;
  const classes = ['file-type-icon', className].filter(Boolean).join(' ');

  if (!iconName || !iconUrl) {
    return (
      <span
        className={`codicon codicon-file ${classes}`}
        data-file-icon="fallback"
        aria-hidden="true"
      />
    );
  }

  return (
    <img
      className={classes}
      src={iconUrl}
      alt=""
      aria-hidden="true"
      data-file-icon={iconName}
      decoding="async"
      loading="lazy"
    />
  );
}

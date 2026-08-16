import { personInitial } from './drive-model';

export function DriveAvatar({
  name,
  avatarUrl,
  me = false,
  size = 'sm',
}: {
  name: string;
  avatarUrl?: string | null;
  me?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span
      className={`drive-avatar drive-avatar--${size}${me ? ' drive-avatar--me' : ''}`}
      title={name}
      aria-hidden="true"
    >
      {avatarUrl ? <img src={avatarUrl} alt="" /> : personInitial(name)}
    </span>
  );
}

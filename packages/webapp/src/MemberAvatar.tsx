import { squareAvatarUrl } from './avatar-url';

function personInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function MemberAvatar({
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
      className={`member-avatar member-avatar--${size}${me ? ' member-avatar--me' : ''}`}
      title={name}
      aria-hidden="true"
    >
      {avatarUrl ? <img src={squareAvatarUrl(avatarUrl)} alt="" /> : personInitial(name)}
    </span>
  );
}

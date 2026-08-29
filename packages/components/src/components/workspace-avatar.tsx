import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Building2 } from 'lucide-react';
import { useStableAvatarSrc } from '@/hooks/use-stable-avatar-src';
import { cn } from '@/lib/utils';

interface WorkspaceAvatarProps {
  workspace?: {
    name?: string | null;
    /** BetterAuth stores the workspace avatar in `organization.logo`. */
    logo?: string | null;
  } | null;
  className?: string;
  fallbackClassName?: string;
}

/* Deterministic 0–359 hue from a string — same recipe as
   `MobileInitialLetterAvatar` so workspace tiles stay stable across
   surfaces (header chip, switcher sheet, desktop sidebar). */
function stringToHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** First grapheme uppercased (CJK / emoji-safe). */
function firstGraphemeUpper(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return Array.from(trimmed)[0]!.toUpperCase();
}

/**
 * Workspace (organization) avatar. Shares the stable blob-cache strategy with
 * {@link UserAvatar} via `useStableAvatarSrc`.
 *
 * Default (no logo): first letter / character of the workspace name on a
 * hashed solid color — matches the mobile home header fallback.
 */
export function WorkspaceAvatar({
  workspace,
  className,
  fallbackClassName,
}: WorkspaceAvatarProps) {
  const avatarImage = useStableAvatarSrc(workspace?.logo);
  const name = workspace?.name ?? '';
  const initial = firstGraphemeUpper(name);
  const hue = stringToHue(name || 'workspace');

  return (
    <Avatar className={className}>
      <AvatarImage src={avatarImage} alt={workspace?.name || 'Workspace'} />
      <AvatarFallback
        className={cn(
          fallbackClassName,
          initial ? 'font-semibold text-white' : 'bg-muted text-muted-foreground'
        )}
        style={
          initial
            ? { backgroundColor: `hsl(${hue} 62% 52%)` }
            : undefined
        }
      >
        {initial ?? <Building2 className="h-4 w-4" />}
      </AvatarFallback>
    </Avatar>
  );
}

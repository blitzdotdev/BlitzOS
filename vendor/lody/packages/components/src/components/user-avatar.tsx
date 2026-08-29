import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { UserIcon } from 'lucide-react';
import { useStableAvatarSrc } from '@/hooks/use-stable-avatar-src';

interface UserAvatarProps {
  /**
   * 用户对象，包含用户信息
   */
  user?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
    email?: string | null;
  } | null;
  /**
   * 头像大小样式类
   */
  className?: string;
  /**
   * Fallback 样式类
   */
  fallbackClassName?: string;
  /**
   * 是否显示默认图标而不是首字母
   */
  showIcon?: boolean;
}

/**
 * 用户头像组件
 * 统一处理用户头像的显示，支持图片和首字母fallback
 */
export function UserAvatar({
  user,
  className,
  fallbackClassName,
  showIcon = false,
}: UserAvatarProps) {
  const avatarImage = useStableAvatarSrc(user?.image);

  // TODO: 为 Lody CLI 添加一个特殊的 fallback
  // 获取用户名首字母作为 fallback
  const getInitials = () => {
    if (!user?.name) return null;
    const names = user.name.trim().split(' ');
    if (names.length === 1) {
      return names[0].charAt(0).toUpperCase();
    }
    // 如果有多个单词，取前两个单词的首字母
    return (names[0].charAt(0) + names[names.length - 1].charAt(0)).toUpperCase();
  };

  const initials = getInitials();

  return (
    <Avatar className={className}>
      <AvatarImage src={avatarImage} alt={user?.name || 'User'} />
      <AvatarFallback className={fallbackClassName}>
        {showIcon || !initials ? <UserIcon className="h-4 w-4" /> : initials}
      </AvatarFallback>
    </Avatar>
  );
}

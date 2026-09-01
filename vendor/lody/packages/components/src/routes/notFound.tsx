/**
 * 404 捕获路由
 * 处理所有未匹配的路由
 */
import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '@/components/not-found';

export const Route = createFileRoute('/notFound')({
  component: NotFound,
});

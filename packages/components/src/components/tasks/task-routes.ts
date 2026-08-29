/**
 * TanStack route id for a single task. Used with `useParams({ from, shouldThrow:
 * false })` so deep links and the All Tasks index share one param reader without
 * `strict: false` (which can miss a leaf param when the match tree is ambiguous).
 */
export const TASK_DETAIL_ROUTE_ID = '/$workspaceName/_auth/tasks/$taskId' as const;

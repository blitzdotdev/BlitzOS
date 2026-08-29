export function RouteMessage({ title, description = '' }: { title: string; description?: string }) {
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background p-6 text-center">
      <div className="max-w-sm space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        ) : null}
      </div>
    </div>
  );
}

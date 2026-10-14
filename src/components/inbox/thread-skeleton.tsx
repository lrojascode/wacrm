/** Static placeholders: no pulse/shimmer that would introduce more flicker. */
export function ThreadSkeleton() {
  return (
    <div
      data-testid="thread-skeleton"
      aria-hidden="true"
      className="flex min-h-full flex-col justify-end gap-4"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div
          key={i}
          className={`border-border/40 bg-muted/60 rounded-xl border ${i % 3 === 0 ? 'ml-auto w-2/5' : 'w-3/5'} ${i % 2 ? 'h-16' : 'h-10'}`}
        />
      ))}
    </div>
  );
}

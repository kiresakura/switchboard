import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        <h1 className="mb-2 text-6xl font-bold text-[var(--muted-foreground)]">
          404
        </h1>
        <p className="mb-6 text-sm text-[var(--muted-foreground)]">
          找不到此頁面
        </p>
        <Link
          href="/workspace"
          className="rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90"
        >
          返回首頁
        </Link>
      </div>
    </div>
  );
}

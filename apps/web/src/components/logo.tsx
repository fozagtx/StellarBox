import Link from "next/link";

export function Logo({ href = "/app" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em]">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink text-white">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
        </svg>
      </span>
      StellaBox
    </Link>
  );
}

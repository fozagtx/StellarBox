import Link from "next/link";
import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { Logo } from "../components/logo";

const CLOUDS = [
  { src: "/landing/cloud-a.webp", width: 520, top: "6%", opacity: 0.95, dur: "120s", delay: "-30s" },
  { src: "/landing/cloud-b.webp", width: 760, top: "18%", opacity: 0.7, dur: "160s", delay: "-100s" },
  { src: "/landing/cloud-a.webp", width: 340, top: "32%", opacity: 0.85, dur: "95s", delay: "-60s" },
  { src: "/landing/cloud-b.webp", width: 600, top: "46%", opacity: 0.55, dur: "140s", delay: "-15s" },
  { src: "/landing/cloud-a.webp", width: 420, top: "52%", opacity: 0.8, dur: "110s", delay: "-85s" },
];

const FLOATERS = [
  { src: "/landing/coin-usdc.webp", className: "left-[7%] top-[60%] w-[64px] md:left-[6%] md:top-[22%] md:w-[110px]", dur: "6s", delay: "0s" },
  { src: "/landing/lock.webp", className: "left-[16%] top-[56%] hidden w-[70px] md:block", dur: "7.5s", delay: "-2s" },
  { src: "/landing/coin-star.webp", className: "right-[9%] top-[57%] w-[58px] md:right-[7%] md:top-[18%] md:w-[104px]", dur: "8s", delay: "-3s" },
  { src: "/landing/coin-usdc.webp", className: "right-[4%] top-[44%] hidden w-[64px] md:block", dur: "9s", delay: "-4s" },
];

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden bg-[#8ec5f0] bg-[url(/landing/sky-hill.webp)] bg-cover bg-[position:78%_100%] md:bg-bottom">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {CLOUDS.map((cloud, index) => (
          <img
            key={index}
            src={cloud.src}
            alt=""
            draggable={false}
            className="sky-cloud"
            style={{ width: cloud.width, top: cloud.top, opacity: cloud.opacity, "--dur": cloud.dur, "--delay": cloud.delay } as CSSProperties}
          />
        ))}
        {FLOATERS.map((floater) => (
          <img
            key={floater.className}
            src={floater.src}
            alt=""
            draggable={false}
            className={`floater ${floater.className}`}
            style={{ "--dur": floater.dur, "--delay": floater.delay } as CSSProperties}
          />
        ))}
      </div>

      <header className="relative z-10 flex justify-center px-4 pt-4">
        <nav className="flex w-full max-w-[560px] items-center justify-between rounded-full border border-white/60 bg-white/85 py-2 pl-5 pr-2 shadow-[0_10px_30px_-18px_rgba(22,19,15,0.28)] backdrop-blur-md">
          <Logo href="/" />
          <div className="flex items-center gap-1">
            <a href="https://github.com/fozagtx/StellarBox" className="hidden rounded-full px-3 py-2 text-[14px] font-medium text-ink/60 hover:text-ink sm:block">
              GitHub
            </a>
            <Link href="/onboarding" className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[14px] font-medium text-white hover:bg-black/85">
              Open wallet
            </Link>
          </div>
        </nav>
      </header>

      <section className="relative z-10 mx-auto flex max-w-[920px] flex-col items-center px-5 pb-40 pt-[12vh] text-center">
        <h1 className="animate-float-up font-display text-[44px] font-normal leading-[1.04] tracking-[-0.02em] text-[#101820] md:text-[92px]">
          A wallet your AI agents
          <br />
          can&apos;t{" "}
          <span className="ring-word relative ml-[0.08em] inline-block italic">
            overspend.
            <svg viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden className="absolute left-[-7%] top-[-12%] h-[124%] w-[114%] overflow-visible">
              <path
                d="M168 9C130 0 42 2 14 20C-8 35 22 58 98 61C168 63 198 46 195 28C192 12 158 4 112 5"
                pathLength={1}
                fill="none"
                stroke="#0f6b4f"
                strokeWidth={1.3}
                strokeLinecap="round"
              />
            </svg>
          </span>
        </h1>
        <p className="animate-float-up mt-6 max-w-[560px] text-[17px] leading-relaxed text-[#2c3a48] [animation-delay:120ms] md:text-[20px]">
          Every agent gets its own key and a USDC budget your Stellar smart account enforces. Anything over it waits for your passkey.
        </p>
        <div className="animate-float-up mt-9 flex flex-wrap justify-center gap-3 [animation-delay:220ms]">
          <Link href="/onboarding" className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-7 text-[15px] font-semibold text-white shadow-[0_10px_24px_-12px_rgba(22,19,15,0.6)] hover:bg-black/85">
            Create a wallet <ArrowRight size={16} />
          </Link>
          <Link href="/onboarding" className="inline-flex h-12 items-center rounded-full border border-[#d9d3c8] bg-white px-7 text-[15px] font-semibold text-[#39342d] hover:bg-[#f6f3ed]">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  );
}

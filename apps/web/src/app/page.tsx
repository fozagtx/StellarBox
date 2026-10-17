import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Logo } from "../components/logo";

const POINTS = [
  { title: "Caps live on-chain", body: "Daily and per-payment limits are Soroban policies on your smart account. A leaked agent key still can't go past them." },
  { title: "One key per agent", body: "Each grant gets its own signer. Revoke one with your passkey and only that agent loses access." },
  { title: "Pays x402 APIs", body: "Agents connect over MCP with OAuth and pay x402 endpoints in USDC. Anything over the cap waits for you." },
];

export default function HomePage() {
  return (
    <main className="bg-paper">
      <section className="relative min-h-[100svh] overflow-hidden">
        <img src="/hero.jpg" alt="A woman and a small robot sitting on a grassy hill at sunset" className="absolute inset-0 h-full w-full object-cover object-[70%_center]" />
        <div className="absolute inset-0 bg-gradient-to-b from-[#f6eadb]/40 via-transparent to-transparent" />
        <header className="relative z-10 flex justify-center px-4 pt-5">
          <nav className="flex w-full max-w-[860px] items-center justify-between rounded-full bg-white/80 py-2 pl-5 pr-2 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.2)] backdrop-blur-md">
            <Logo href="/" />
            <div className="hidden items-center gap-7 text-[14px] text-ink/70 md:flex">
              <a href="#how" className="hover:text-ink">How it works</a>
              <a href="https://github.com/fozagtx/StellarBox" className="hover:text-ink">GitHub</a>
            </div>
            <Link href="/onboarding" className="inline-flex h-10 items-center rounded-full bg-ink px-5 text-[14px] font-medium text-white hover:bg-black/85">
              Open wallet
            </Link>
          </nav>
        </header>
        <div className="relative z-10 mx-auto max-w-[1180px] px-6 pt-[14vh] md:px-10">
          <h1 className="animate-float-up max-w-[760px] text-[52px] font-semibold leading-[0.98] tracking-[-0.045em] text-ink md:text-[84px]">
            A wallet your AI agents
            <span className="mx-3 inline-flex h-[0.8em] w-[0.8em] translate-y-[0.06em] items-center justify-center rounded-[0.22em] bg-ink align-baseline text-white">
              <ShieldCheck className="h-[0.5em] w-[0.5em]" strokeWidth={2.2} />
            </span>
            can&apos;t overspend.
          </h1>
          <p className="animate-float-up mt-6 max-w-[520px] text-[18px] leading-relaxed text-ink/70 [animation-delay:120ms]">
            StellaBox gives each agent its own key and a USDC budget your Stellar smart account enforces. You approve anything above it with your passkey.
          </p>
          <div className="animate-float-up mt-9 flex flex-wrap gap-3 [animation-delay:220ms]">
            <Link href="/onboarding" className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-7 text-[15px] font-medium text-white hover:bg-black/85">
              Create a wallet <ArrowRight size={16} />
            </Link>
            <a href="#how" className="inline-flex h-12 items-center rounded-full bg-white/80 px-7 text-[15px] font-medium text-ink backdrop-blur hover:bg-white">
              How it works
            </a>
          </div>
        </div>
      </section>
      <section id="how" className="mx-auto max-w-[1180px] px-6 py-24 md:px-10">
        <h2 className="max-w-[620px] text-[40px] font-semibold leading-[1.05] tracking-[-0.035em]">The limits sit in the contract, not in our backend.</h2>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title} className="rounded-3xl border border-line bg-white p-7">
              <h3 className="text-[18px] font-semibold tracking-[-0.02em]">{point.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{point.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-16 text-[13px] text-muted">Runs on Stellar testnet. Test funds only.</p>
      </section>
    </main>
  );
}

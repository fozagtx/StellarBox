"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  BellRing,
  Download,
  KeyRound,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import { Logo } from "./logo";

const NAV = [
  { href: "/app", label: "Wallet", icon: LayoutGrid },
  { href: "/app/grants", label: "Grants", icon: KeyRound },
  { href: "/app/approvals", label: "Approvals", icon: BellRing },
  { href: "/app/activity", label: "Activity", icon: Activity },
  { href: "/app/deposit", label: "Deposit", icon: Download },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

const STORAGE_KEY = "stellabox.sidebar.collapsed";

export function Sidebar({ pendingApprovals }: { pendingApprovals: number }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  function toggle() {
    setCollapsed((value) => {
      window.localStorage.setItem(STORAGE_KEY, value ? "0" : "1");
      return !value;
    });
  }

  return (
    <aside
      className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-cream/60 px-3 py-5 transition-[width] duration-200 md:flex ${collapsed ? "w-[68px]" : "w-[232px]"}`}
    >
      <div className={`mb-8 flex items-center ${collapsed ? "justify-center" : "justify-between px-2"}`}>
        {collapsed ? null : <Logo />}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={`relative flex h-10 items-center gap-3 rounded-xl text-[14px] font-medium transition ${collapsed ? "justify-center" : "px-3"} ${active ? "bg-white text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-muted hover:bg-black/5 hover:text-ink"}`}
            >
              <Icon size={18} strokeWidth={1.8} />
              {collapsed ? null : <span>{label}</span>}
              {label === "Approvals" && pendingApprovals > 0 ? (
                <span
                  className={`flex h-5 min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-[11px] font-semibold text-white ${collapsed ? "absolute right-1.5 top-1" : "ml-auto"}`}
                >
                  {pendingApprovals}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className={`mt-auto text-[12px] text-muted ${collapsed ? "text-center" : "px-3"}`}>
        {collapsed ? "T" : "Stellar testnet"}
      </div>
    </aside>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 flex justify-around border-t border-line bg-white/95 py-2 backdrop-blur md:hidden">
      {NAV.slice(0, 5).map(({ href, label, icon: Icon }) => {
        const active = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={`flex flex-col items-center gap-0.5 px-2 text-[11px] ${active ? "text-ink" : "text-muted"}`}>
            <Icon size={20} strokeWidth={1.8} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

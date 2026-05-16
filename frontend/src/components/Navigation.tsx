"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useX1Wallet, X1_WALLET_URL, X1_WALLET_ICON } from "@/lib/X1WalletContext";
import {
  HomeIcon,
  CubeIcon,
  BoltIcon,
  ClockIcon,
  UsersIcon,
  BookOpenIcon,
  Bars3Icon,
  XMarkIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowLeftEndOnRectangleIcon,
} from "@heroicons/react/24/outline";

const navigation = [
  { name: "Dashboard", href: "/", icon: HomeIcon },
  { name: "dApps", href: "/dapps", icon: CubeIcon },
  { name: "Request", href: "/request", icon: BoltIcon },
  { name: "Rounds", href: "/rounds", icon: ClockIcon },
  { name: "Validators", href: "/validators", icon: UsersIcon },
  { name: "Docs", href: "/docs", icon: BookOpenIcon },
];

export default function Navigation() {
  const pathname = usePathname();
  const { connected, address, connecting, walletDetected, connect, disconnect } = useX1Wallet();
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

  const shortAddress = address
    ? `${address.slice(0, 4)}...${address.slice(-4)}`
    : null;

  return (
    <nav className="bg-white border-b border-border">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          {/* Logo */}
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
                <span className="text-white font-bold text-xs">R</span>
              </div>
              <span className="text-sm font-semibold text-text-primary hidden sm:block">
                X1 Randomness
              </span>
            </Link>
          </div>

          {/* Desktop navigation */}
          <div className="hidden md:block">
            <div className="flex items-center space-x-1">
              {navigation.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary/10 text-primary"
                        : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                    }`}
                  >
                    <item.icon className="h-4 w-4" />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* X1 Wallet button */}
          <div className="hidden md:flex items-center">
            {!walletDetected ? (
              <a
                href={X1_WALLET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors text-sm font-medium"
              >
                <img src={X1_WALLET_ICON} alt="X1" className="h-4 w-4 rounded" />
                Install X1 Wallet
              </a>
            ) : connected ? (
              <button
                onClick={disconnect}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 transition-colors text-sm font-medium"
              >
                <img src={X1_WALLET_ICON} alt="X1" className="h-4 w-4 rounded" />
                <span className="font-mono text-xs">{shortAddress}</span>
                <ArrowRightStartOnRectangleIcon className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={connecting}
                className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-white hover:bg-primary-hover transition-colors text-sm font-medium disabled:opacity-50"
              >
                <img src={X1_WALLET_ICON} alt="X1" className="h-4 w-4 rounded" />
                {connecting ? "Connecting..." : "Connect"}
                <ArrowLeftEndOnRectangleIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Mobile menu button */}
          <div className="flex md:hidden items-center gap-2">
            {!walletDetected ? (
              <a
                href={X1_WALLET_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 rounded border border-border text-text-secondary text-xs"
              >
                <img src={X1_WALLET_ICON} alt="X1" className="h-3.5 w-3.5 rounded" />
                Install
              </a>
            ) : connected ? (
              <button
                onClick={disconnect}
                className="flex items-center gap-1 px-2 py-1 rounded border border-primary/30 bg-primary/5 text-primary text-xs font-mono"
              >
                {shortAddress}
              </button>
            ) : (
              <button
                onClick={connect}
                disabled={connecting}
                className="flex items-center gap-1 px-2 py-1 rounded bg-primary text-white text-xs disabled:opacity-50"
              >
                Connect
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:bg-surface-hover"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            >
              {mobileMenuOpen ? (
                <XMarkIcon className="h-5 w-5" />
              ) : (
                <Bars3Icon className="h-5 w-5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-border bg-white">
          <div className="space-y-1 px-3 py-2">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                  }`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <item.icon className="h-4 w-4" />
                  {item.name}
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
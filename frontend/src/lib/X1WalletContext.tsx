"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { Connection, PublicKey, Transaction, TransactionSignature } from "@solana/web3.js";
import { RPC_URL } from "@/lib/constants";

// ─── Types ───────────────────────────────────────────────────────────

interface X1WalletProvider {
  isX1Wallet?: boolean;
  isX1?: boolean;
  isConnected: boolean;
  publicKey: { toBytes(): Uint8Array } | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  signTransaction<T>(tx: T): Promise<T>;
  signAllTransactions<T>(txs: T[]): Promise<T[]>;
  signMessage(message: Uint8Array): Promise<{ signature: Uint8Array }>;
  on?(event: string, callback: (...args: any[]) => void): void;
  off?(event: string, callback: (...args: any[]) => void): void;
}

type X1Window = Window & typeof globalThis & {
  x1Wallet?: X1WalletProvider;
  x1?: X1WalletProvider;
  backpack?: X1WalletProvider;
  solana?: X1WalletProvider & { isX1Wallet?: boolean; isX1?: boolean };
};

interface WalletState {
  connected: boolean;
  publicKey: PublicKey | null;
  address: string | null;
  connecting: boolean;
  walletDetected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signTransaction: <T>(tx: T) => Promise<T>;
  signAllTransactions: <T>(txs: T[]) => Promise<T[]>;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  sendTransaction: (transaction: Transaction) => Promise<TransactionSignature>;
}

const WalletContext = createContext<WalletState>({
  connected: false,
  publicKey: null,
  address: null,
  connecting: false,
  walletDetected: false,
  connect: async () => {},
  disconnect: async () => {},
  signTransaction: async <T,>(tx: T): Promise<T> => tx,
  signAllTransactions: async <T,>(txs: T[]): Promise<T[]> => txs,
  signMessage: async () => new Uint8Array(),
  sendTransaction: async () => "",
});

export const useX1Wallet = () => useContext(WalletContext);
export const useConnection = () => {
  const connection = useRef(new Connection(RPC_URL, "confirmed"));
  return { connection: connection.current };
};

// ─── Detection ───────────────────────────────────────────────────────

function detectProvider(): X1WalletProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as X1Window;
  // Priority: x1Wallet > x1 > backpack > solana (with X1 flags)
  return (
    w.x1Wallet ||
    w.x1 ||
    w.backpack ||
    (w.solana && (w.solana.isX1Wallet || w.solana.isX1) ? w.solana : null) ||
    null
  );
}

// ─── Base58 ──────────────────────────────────────────────────────────

function base58Encode(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) result += "1";
  for (let i = digits.length - 1; i >= 0; i--) result += alphabet[digits[i]];
  return result;
}

// ─── Provider Component ──────────────────────────────────────────────

const SESSION_KEY = "x1_wallet_address";

export default function X1WalletContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [connected, setConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletDetected, setWalletDetected] = useState(false);
  const providerRef = useRef<X1WalletProvider | null>(null);
  const connectionRef = useRef(new Connection(RPC_URL, "confirmed"));

  // Detect wallet on mount
  useEffect(() => {
    const p = detectProvider();
    setWalletDetected(!!p);
    providerRef.current = p;

    // Auto-reconnect from sessionStorage
    const savedAddress = sessionStorage.getItem(SESSION_KEY);
    if (p && savedAddress) {
      try {
        const pk = new PublicKey(savedAddress);
        setPublicKey(pk);
        setAddress(savedAddress);
        setConnected(true);
      } catch {
        sessionStorage.removeItem(SESSION_KEY);
      }
    }

    // Listen for account changes
    const handleAccountChange = () => {
      const prov = providerRef.current;
      if (prov && prov.publicKey) {
        const addr = base58Encode(prov.publicKey.toBytes());
        const pk = new PublicKey(addr);
        setPublicKey(pk);
        setAddress(addr);
        sessionStorage.setItem(SESSION_KEY, addr);
      } else {
        setPublicKey(null);
        setAddress(null);
        setConnected(false);
        sessionStorage.removeItem(SESSION_KEY);
      }
    };

    if (p?.on) {
      p.on("accountChanged", handleAccountChange);
      p.on("disconnect", () => {
        setConnected(false);
        setPublicKey(null);
        setAddress(null);
        sessionStorage.removeItem(SESSION_KEY);
      });
    }

    return () => {
      if (p?.off) {
        p.off("accountChanged", handleAccountChange);
      }
    };
  }, []);

  const connect = useCallback(async () => {
    const prov = providerRef.current || detectProvider();
    if (!prov) {
      throw new Error("X1 Wallet not detected. Please install the X1 Wallet extension.");
    }
    providerRef.current = prov;
    setConnecting(true);
    try {
      await prov.connect();
      if (prov.publicKey) {
        const addr = base58Encode(prov.publicKey.toBytes());
        const pk = new PublicKey(addr);
        setPublicKey(pk);
        setAddress(addr);
        setConnected(true);
        sessionStorage.setItem(SESSION_KEY, addr);
      }
    } catch (err) {
      console.error("[X1 Wallet] Connection failed:", err);
      throw err;
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const prov = providerRef.current;
    if (prov) {
      try { await prov.disconnect(); } catch { /* ignore */ }
    }
    setConnected(false);
    setPublicKey(null);
    setAddress(null);
    sessionStorage.removeItem(SESSION_KEY);
  }, []);

  const signTransaction = useCallback(async <T,>(tx: T): Promise<T> => {
    const prov = providerRef.current;
    if (!prov) throw new Error("Wallet not connected");
    return prov.signTransaction(tx);
  }, []);

  const signAllTransactions = useCallback(async <T,>(txs: T[]): Promise<T[]> => {
    const prov = providerRef.current;
    if (!prov) throw new Error("Wallet not connected");
    return prov.signAllTransactions(txs);
  }, []);

  const signMessage = useCallback(async (message: Uint8Array): Promise<Uint8Array> => {
    const prov = providerRef.current;
    if (!prov) throw new Error("Wallet not connected");
    const { signature } = await prov.signMessage(message);
    return signature;
  }, []);

  const sendTransaction = useCallback(async (transaction: Transaction): Promise<TransactionSignature> => {
    const prov = providerRef.current;
    if (!prov || !publicKey) throw new Error("Wallet not connected");
    const signed = await prov.signTransaction(transaction);
    return connectionRef.current.sendRawTransaction(signed.serialize());
  }, [publicKey]);

  const value: WalletState = {
    connected,
    publicKey,
    address,
    connecting,
    walletDetected,
    connect,
    disconnect,
    signTransaction,
    signAllTransactions,
    signMessage,
    sendTransaction,
  };

  return (
    <WalletContext.Provider value={value}>
      {children}
    </WalletContext.Provider>
  );
}

export const X1_WALLET_URL = "https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae";
export const X1_WALLET_ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxNiIgY3k9IjE2IiByPSIxNCIgZmlsbD0iIzAwOERFQiIvPjx0ZXh0IHg9IjgiIHk9IjIyIiBmb250LXNpemU9IjE4IiBmb250LXdlaWdodD0iYm9sZCIgZmlsbD0id2hpdGUiPlgxPC90ZXh0Pjwvc3ZnPg==";
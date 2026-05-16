import type { Metadata } from "next";
import "./globals.css";
import X1WalletContextProvider from "@/lib/X1WalletContext";
import Navigation from "@/components/Navigation";

export const metadata: Metadata = {
  title: "X1 Randomness Protocol",
  description: "On-demand randomness with sub-second latency on X1 Mainnet",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background">
        <X1WalletContextProvider>
          <Navigation />
          <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>
        </X1WalletContextProvider>
      </body>
    </html>
  );
}
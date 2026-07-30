import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import "./globals.css";

// The design system specifies Goga for display and Inter Variable for UI.
// Goga is not freely available; DESIGN.md names Inter Tight as the approved
// substitute. Both bind to token names, so swapping in the real face later is
// a one-line change here. See design/README.md.
const display = Inter_Tight({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const ui = Inter({
  variable: "--font-ui",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "SniffSniffSquared",
  description: "Dofus 3 marketplace prices, captured off the wire",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

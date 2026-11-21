import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { cookieToInitialState } from 'wagmi';
import { Providers } from '@/components/providers';
import { getWagmiConfig } from '@/lib/wagmi';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'TRACEB3 — Digital Waste Passport',
    template: '%s | TRACEB3',
  },
  description:
    'Tamper-evident chain of custody for industrial B3 hazardous waste, complementing Festronik and MONIJA.',
};

export const viewport: Viewport = {
  themeColor: '#0F3D3E',
  colorScheme: 'light',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const headersObj = await headers();
  const initialState = cookieToInitialState(getWagmiConfig(), headersObj.get('cookie'));

  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh">
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}

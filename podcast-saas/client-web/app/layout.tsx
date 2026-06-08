import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { FirebaseAuthProvider } from '../lib/firebase';
import { ThemeProvider } from '../lib/theme';
import { PlatformGate } from '../components/PlatformGate';

const inter = Inter({ subsets: ['latin'] });

const SITE_URL = process.env.PUBLIC_SITE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Interactive Video Studio',
  description: 'Upload videos, mark sections, and build interactive watch experiences.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const themeScript = `
    (() => {
      try {
        const stored = localStorage.getItem('podcast-saas-theme') || 'light';
        const theme = stored === 'system'
          ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : stored;
        document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
        const prefs = JSON.parse(localStorage.getItem('podcast-saas-user-preferences') || '{}');
        document.documentElement.dataset.motion = prefs.reduceMotion ? 'reduced' : 'full';
        document.documentElement.dataset.editorDensity = prefs.compactEditor ? 'compact' : 'comfortable';
      } catch (_) {
        document.documentElement.dataset.theme = 'light';
      }
    })();
  `;

  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className={`${inter.className} h-full antialiased`} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <ThemeProvider>
          <FirebaseAuthProvider>
            <PlatformGate>{children}</PlatformGate>
          </FirebaseAuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

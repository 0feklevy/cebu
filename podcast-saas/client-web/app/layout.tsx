import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { FirebaseAuthProvider } from '../lib/firebase';
import { PlatformGate } from '../components/PlatformGate';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'PodcastAI — Generate Two-Host Podcasts',
  description: 'Turn any idea or document into a broadcast-quality two-host video podcast.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full antialiased`}>
        <FirebaseAuthProvider>
          <PlatformGate>{children}</PlatformGate>
        </FirebaseAuthProvider>
      </body>
    </html>
  );
}

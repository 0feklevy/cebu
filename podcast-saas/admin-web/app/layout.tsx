import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AdminFirebaseAuthProvider } from '../lib/firebase';
import { AdminGate } from '../components/AdminGate';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'PodcastAI Admin',
  description: 'Admin portal for PodcastAI platform management.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Kill-switch for any stale service worker (admin ships none). Safe to always run.
  const swCleanupScript = `
    (() => {
      try {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations()
            .then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
        }
        if (window.caches && caches.keys) {
          caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
        }
      } catch (_) {}
    })();
  `;
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full antialiased`}>
        <script dangerouslySetInnerHTML={{ __html: swCleanupScript }} />
        <AdminFirebaseAuthProvider>
          <AdminGate>{children}</AdminGate>
        </AdminFirebaseAuthProvider>
      </body>
    </html>
  );
}

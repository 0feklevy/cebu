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
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} h-full antialiased`}>
        <AdminFirebaseAuthProvider>
          <AdminGate>{children}</AdminGate>
        </AdminFirebaseAuthProvider>
      </body>
    </html>
  );
}

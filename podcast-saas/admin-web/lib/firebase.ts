'use client';

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useState } from 'react';
import React from 'react';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);

export interface AdminAuthContextValue {
  user: User | null;
  loading: boolean;
  isAdmin: boolean | null;
  getIdToken: () => Promise<string | null>;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

export const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export function AdminFirebaseAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        // Check isAdmin from backend
        try {
          const token = await firebaseUser.getIdToken();
          const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';
          const res = await fetch(`${apiUrl}/api/admin/v1/settings`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          setIsAdmin(res.ok);
        } catch {
          setIsAdmin(false);
        }
      } else {
        setIsAdmin(null);
      }
      setLoading(false);
    });
  }, []);

  const getIdToken = async () => auth.currentUser?.getIdToken() ?? null;
  const signInWithGoogle = async () => {
    await signInWithPopup(auth, new GoogleAuthProvider());
  };
  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };
  const signOutUser = async () => {
    await signOut(auth);
    setIsAdmin(null);
  };

  return React.createElement(
    AdminAuthContext.Provider,
    { value: { user, loading, isAdmin, getIdToken, signInWithGoogle, signInWithEmail, signOutUser } },
    children,
  );
}

export function useAdminAuth(): AdminAuthContextValue {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be inside AdminFirebaseAuthProvider');
  return ctx;
}

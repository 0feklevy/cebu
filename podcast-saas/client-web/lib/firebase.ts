'use client';

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  connectAuthEmulator,
  signInAnonymously,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
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

/**
 * LOCAL AUTH EMULATOR — opt-in, never in a production build.
 *
 * `FirebaseAuthProvider` signs guests in anonymously on mount, which is a live call to
 * `identitytoolkit.googleapis.com`. That makes any "this gate ran entirely on loopback" claim false
 * by construction — the sim-pool network guard caught exactly this. Pointing the SDK at a local
 * emulator keeps the production code path identical (the same `signInAnonymously`, the same
 * `onAuthStateChanged`) while the traffic terminates on 127.0.0.1.
 *
 * Guarded three ways so it cannot engage in a deployed build: the variable must be set, NODE_ENV
 * must not be production, and the host must itself be loopback. A non-loopback value is refused
 * rather than honoured — failing closed to the real backend beats silently pointing authentication
 * at someone else's machine.
 */
const AUTH_EMULATOR_HOST = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
if (AUTH_EMULATOR_HOST && process.env.NODE_ENV !== 'production') {
  const host = AUTH_EMULATOR_HOST.split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    connectAuthEmulator(auth, `http://${AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  } else {
    // eslint-disable-next-line no-console
    console.error(`[firebase] refusing non-loopback auth emulator host: ${AUTH_EMULATOR_HOST}`);
  }
}

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isAnonymous: boolean;
  getIdToken: () => Promise<string | null>;
  signInAnonymouslyFn: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function FirebaseAuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
      } else {
        // Auto-create anonymous identity for guests
        try {
          await signInAnonymously(auth);
        } catch {
          setUser(null);
        }
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const getIdToken = async () => {
    return auth.currentUser?.getIdToken() ?? null;
  };

  const signInAnonymouslyFn = async () => {
    await signInAnonymously(auth);
  };

  const signInWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };

  const signInWithEmail = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const signUpWithEmail = async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  };

  const signOutUser = async () => {
    await signOut(auth);
  };

  return React.createElement(
    AuthContext.Provider,
    {
      value: {
        user,
        loading,
        isAnonymous: user?.isAnonymous ?? false,
        getIdToken,
        signInAnonymouslyFn,
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        signOutUser,
      },
    },
    children,
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside FirebaseAuthProvider');
  return ctx;
}

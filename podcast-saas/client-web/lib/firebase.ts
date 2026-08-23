'use client';

import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  browserLocalPersistence,
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
import { authEmulatorOrigin } from 'shared/src/csp';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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

const AUTH_EMULATOR_HOST = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
/**
 * ONE validator, shared with the CSP, and the ORIGIN IT RETURNS is what gets used.
 *
 * `AUTH_EMULATOR_HOST.split(':')[0]` is not the host. For `localhost:9099@attacker.example.com` it
 * yields "localhost" — so a loopback check passes — while `new URL('http://' + value)` resolves to
 * `attacker.example.com`, because the leading text is userinfo. Interpolating the raw value after
 * checking a split of it would therefore point anonymous sign-in at a remote host. `authEmulatorOrigin`
 * parses the authority and rebuilds the origin from the parsed parts, so the string that is
 * validated is necessarily the string that is connected to.
 */
const authEmulatorUrl = authEmulatorOrigin(AUTH_EMULATOR_HOST, process.env.NODE_ENV !== 'production');
const useAuthEmulator = authEmulatorUrl !== '';

/**
 * `getAuth()` installs the browser popup/redirect resolver, and that resolver loads the gapi
 * auth iframe from `https://apis.google.com` — WebKit fetches it on page load, which the
 * loopback-only sim-pool gate correctly refused. Popup and redirect sign-in are never used by the
 * E2E fixture, so on the emulator path auth is initialised WITHOUT that resolver. Every other
 * environment keeps `getAuth()` byte-for-byte, so real popup sign-in is untouched.
 */
export const auth = useAuthEmulator
  ? initializeAuth(app, { persistence: browserLocalPersistence })
  : getAuth(app);

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
if (useAuthEmulator) {
  connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
} else if (AUTH_EMULATOR_HOST && process.env.NODE_ENV !== 'production') {
   
  console.error('[firebase] refusing a non-loopback auth emulator host');
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

  /*
   * EVERY CALLABLE HERE IS MEMOISED, AND THE CONTEXT VALUE WITH THEM (D-13).
   *
   * These were plain function declarations in the provider body inside a fresh object literal, so
   * `getIdToken` — and the whole context value — changed identity on EVERY provider render. That
   * is not a performance detail; it was load-bearing in a way nobody intended:
   *
   *   • it was the viewer's *accidental* config-delivery path. `ViewerPage`'s fetch effect used to
   *     list `getIdToken` as a dependency, so an unrelated provider render re-ran the fetch and a
   *     corrected b-roll list arrived — sometimes, if the auth context happened to re-render (a
   *     cross-tab sign-in was enough). D-13 replaces that coincidence with a deliberate poll, and
   *     a deliberate mechanism is only testable once the accidental one is gone;
   *   • the same identity churn had already torn down that poll's give-up clock on every render,
   *     which is why `ViewerPage` had to route `getIdToken` through a ref to defend itself.
   *
   * None of them close over `user` or `loading`, so `[]` is the honest dependency list: each reads
   * `auth.currentUser` at call time, which is the live value.
   */
  const getIdToken = useCallback(async () => {
    return auth.currentUser?.getIdToken() ?? null;
  }, []);

  const signInAnonymouslyFn = useCallback(async () => {
    await signInAnonymously(auth);
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    await createUserWithEmailAndPassword(auth, email, password);
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    isAnonymous: user?.isAnonymous ?? false,
    getIdToken,
    signInAnonymouslyFn,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    signOutUser,
  }), [
    user, loading,
    getIdToken, signInAnonymouslyFn, signInWithGoogle,
    signInWithEmail, signUpWithEmail, signOutUser,
  ]);

  return React.createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside FirebaseAuthProvider');
  return ctx;
}

'use client';

import { ClientV1Api } from 'shared/src/generated/client-v1';
import { auth } from './firebase';

export function getApiClient(): ClientV1Api {
  return new ClientV1Api({
    baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
    getToken: async () => auth.currentUser?.getIdToken() ?? null,
  });
}

export const api = new ClientV1Api({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  getToken: async () => auth.currentUser?.getIdToken() ?? null,
});

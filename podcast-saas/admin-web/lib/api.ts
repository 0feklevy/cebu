'use client';

import { AdminV1Api } from 'shared/src/generated/admin-v1';
import { auth } from './firebase';

export const adminApi = new AdminV1Api({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? '',
  getToken: async () => auth.currentUser?.getIdToken() ?? null,
});

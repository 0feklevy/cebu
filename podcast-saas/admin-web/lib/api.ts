'use client';

import { AdminV1Api } from 'shared/src/generated/admin-v1';
import { auth } from './firebase';

export const adminApi = new AdminV1Api({
  baseURL: process.env.ADMIN_API_URL ?? 'http://localhost:8080',
  getToken: async () => auth.currentUser?.getIdToken() ?? null,
});

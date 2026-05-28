import admin from 'firebase-admin';

let _app: admin.app.App | undefined;

export function getFirebaseAdmin(): admin.app.App {
  if (_app) return _app;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    throw new Error('Firebase Admin environment variables not configured');
  }

  if (admin.apps.length > 0) {
    _app = admin.apps[0]!;
  } else {
    _app = admin.initializeApp({
      credential: admin.credential.cert({ projectId, privateKey, clientEmail }),
    });
  }

  return _app;
}

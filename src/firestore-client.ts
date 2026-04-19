import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

let db: Firestore | null = null;

export function getDb(): Firestore {
  if (db) return db;

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS environment variable is required"
    );
  }

  const serviceAccount = JSON.parse(
    readFileSync(credPath, "utf-8")
  ) as ServiceAccount;

  const app = initializeApp({
    credential: cert(serviceAccount),
  });

  db = getFirestore(app);
  return db;
}

import { initializeApp, cert, type ServiceAccount } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

let db: Firestore | null = null;

// Accept GOOGLE_APPLICATION_CREDENTIALS as either a file path OR the raw JSON
// contents of a service-account key. Path is the GCP-canonical form; inline
// JSON lets sandboxed environments (Glama's browser MCP Inspector, CI secrets,
// Cloud Run's inlined-secret pattern) work without a writable filesystem.
function loadServiceAccount(credValue: string): ServiceAccount {
  const trimmed = credValue.trim();
  if (trimmed.startsWith("{")) {
    // Looks like inline JSON — parse directly.
    return JSON.parse(trimmed) as ServiceAccount;
  }
  // Otherwise treat as a file path.
  return JSON.parse(readFileSync(credValue, "utf-8")) as ServiceAccount;
}

export function getDb(): Firestore {
  if (db) return db;

  const credValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credValue) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS environment variable is required"
    );
  }

  const serviceAccount = loadServiceAccount(credValue);

  const app = initializeApp({
    credential: cert(serviceAccount),
  });

  db = getFirestore(app);
  return db;
}

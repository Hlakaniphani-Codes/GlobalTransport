import { removeStoredToken } from '@/auth/tokenStorage';

type SessionExpiryHandler = () => Promise<void>;

let handler: SessionExpiryHandler | null = null;
let expiration: Promise<void> | null = null;

export function registerSessionExpiryHandler(nextHandler: SessionExpiryHandler): () => void {
  handler = nextHandler;
  return () => {
    if (handler === nextHandler) handler = null;
  };
}

export function expireSession(): Promise<void> {
  if (!expiration) {
    expiration = (async () => {
      await removeStoredToken();
      await handler?.();
    })().finally(() => {
      expiration = null;
    });
  }
  return expiration;
}

'use client';

/**
 * The shop customer's sign-in, for the browser calls the customer page shares
 * with the tool (lib/sketch-client.ts, lib/mockup-client.ts). Unset on the
 * team's tool, which signs in with the panel's cookie instead.
 */

let token: string | null = null;

export function setCustomerToken(value: string | null): void {
  token = value;
}

export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

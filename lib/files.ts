// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
export type FileItem = { id: string; name: string; kind: "file" | "folder"; size: number; mime: string; parentId: string; createdAt: string; updatedAt: string; starred: boolean; deletedAt?: string; shareToken?: string; shareExpires?: number; status?: string; uploadedById: string; uploadedByName: string };
export type User = { id: string; email: string; name: string; admin: boolean; workspace?: { shared: boolean; name: string; members: { id: string; name: string; email: string }[] } };
export type DocumentItem = { id: string; title: string; type: "agreement" | "receipt" | "invoice"; ownerId: string; ownerEmail: string; recipientEmail: string; recipientName: string; status: "pending" | "published" | "awaiting_signature" | "completed" | "void"; createdAt: string; updatedAt: string; viewedAt?: string; completedAt?: string; emailedAt?: string; emailCount?: number; originalHash?: string; signedHash?: string; signatures?: { userId?: string | null; role?: "owner" | "recipient"; email: string; typedName: string; signedAt: string }[]; recipientUrl?: string };
export const formatBytes = (n: number) => n === 0 ? "0 B" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`;
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof options.body === "string" ? options.body : ""));
  const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  const response = await fetch(`/api${path}`, { ...options, headers: { "Content-Type": "application/json", "x-amz-content-sha256": digest, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

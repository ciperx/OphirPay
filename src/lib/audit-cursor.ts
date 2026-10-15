// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Opaque cursor for audit-log keyset pagination (bounty #1361).
 *
 * The cursor identifies the last row of the previous page. It is base64url of
 * a JSON payload — opaque to clients (they must not parse or build it) and
 * safe to embed in query strings.
 *
 * `k` is the sort-key value of the anchor row, `id` the unique tiebreaker so
 * ordering is stable when sort keys collide (e.g. same timestamp). Direction
 * of the comparison is supplied by the route, not the cursor, so a cursor
 * cannot flip the requested ordering.
 */
export interface AuditLogCursorPayload {
  /** Sort-key value of the anchor row (JSON-encoded to preserve types). */
  k: string;
  /** Unique id of the anchor row — the tiebreaker. */
  id: string;
}

const auditCursorSchema = z.object({
  k: z.string(),
  id: z.string().min(1).max(64),
});

/** Encode a cursor payload into an opaque, URL-safe token. */
export function encodeAuditCursor(payload: AuditLogCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Decode and validate an opaque cursor token.
 *
 * Returns `null` for anything that is not well-formed (non-base64, tampered
 * JSON, wrong shape) so callers can reject it with a 400.
 */
export function decodeAuditCursor(raw: string): AuditLogCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8")
    );
    const result = auditCursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Allowlisted sort fields for the audit-log API (bounty #1361). */
export const AUDIT_LOG_SORT_FIELDS = [
  "timestamp",
  "id",
  "action",
  "actor",
] as const;

export type AuditLogSortField = (typeof AUDIT_LOG_SORT_FIELDS)[number];
export type AuditLogSortDirection = "asc" | "desc";

/**
 * Compare two audit entries by the given sort field with a stable id
 * tiebreaker. Returns a negative number when `a` sorts before `b`, positive
 * when after, 0 only when both field and id are equal.
 */
export function compareAuditEntries(
  a: { id: number | string; timestamp: number; action: string; actor: string },
  b: { id: number | string; timestamp: number; action: string; actor: string },
  sortBy: AuditLogSortField,
  direction: AuditLogSortDirection
): number {
  const av = a[sortBy];
  const bv = b[sortBy];
  let cmp: number;
  if (typeof av === "number" && typeof bv === "number") {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
  // Stable tiebreaker: id ascending regardless of direction.
  return String(a.id).localeCompare(String(b.id), undefined, {
    numeric: true,
  });
}

/** The sort-key value of an entry, for cursor round-tripping. */
export function auditSortKeyValue(
  entry: { id: number | string; timestamp: number; action: string; actor: string },
  sortBy: AuditLogSortField
): string {
  return JSON.stringify(entry[sortBy]);
}

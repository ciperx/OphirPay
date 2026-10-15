// SPDX-License-Identifier: MIT

// Bounty #1361: cursor-based pagination and sorting for GET /api/audit-log.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/audit-log/route";
import {
  encodeAuditCursor,
  decodeAuditCursor,
} from "@/lib/audit-cursor";

vi.mock("@/lib/api-auth", () => ({
  withApiAuth: (handler: (req: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/contracts", () => ({
  simulateContractCall: vi.fn(),
  DEFAULT_CONTRACT_ID: "CC_TEST_CONTRACT",
  CHAIN_READ_SOURCE: "G_TEST_SOURCE",
}));

import { simulateContractCall } from "@/lib/contracts";
const simMock = vi.mocked(simulateContractCall);

beforeEach(() => {
  simMock.mockReset();
});

interface AuditEntry {
  id: number;
  timestamp: number;
  action: string;
  actor: string;
  target_id: number;
  details: string;
}

function baseEntry(id: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id,
    timestamp: 1700000000 + id,
    action: "payment_recorded",
    actor: "GABCDEFGH12345678",
    target_id: id,
    details: `Payment #${id} recorded`,
    ...overrides,
  };
}

function mockLedger(entries: AuditEntry[]) {
  const queue = [...entries].reverse();
  simMock.mockImplementation((_contractId: string, fn: string) => {
    if (fn === "get_audit_log_count") {
      return Promise.resolve({ status: "SIMULATED", returnValue: entries.length });
    }
    if (fn === "get_audit_entry") {
      const e = queue.shift();
      return Promise.resolve({ status: "SIMULATED", returnValue: e ?? null });
    }
    return Promise.resolve({ status: "SIMULATED", returnValue: null });
  });
}

async function get(query = "") {
  return GET(new Request(`http://localhost/api/audit-log${query}`));
}

describe("audit-log cursor pagination (#1361)", () => {
  const ledger = [
    baseEntry(1),
    baseEntry(2, { action: "role_granted", timestamp: 1700000050 }),
    baseEntry(3),
    baseEntry(4, { action: "role_granted", timestamp: 1700000050 }),
    baseEntry(5),
  ];

  it("returns the first cursor page with sort metadata", async () => {
    mockLedger(ledger);

    const res = await get("?cursor=&limit=2&sort_by=timestamp&direction=desc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.sort_by).toBe("timestamp");
    expect(body.meta.direction).toBe("desc");
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.next_cursor).toBeTruthy();
    // desc by timestamp; entries 2 and 4 share the newest timestamp and are
    // tiebroken by id ascending: 2,4 then 5,3,1.
    expect(body.data.map((e: AuditEntry) => e.id)).toEqual([2, 4]);
  });

  it("walks every page via next_cursor without gaps or dupes", async () => {
    mockLedger(ledger);

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q = new URLSearchParams({
        limit: "2",
        sort_by: "timestamp",
        direction: "desc",
      });
      if (cursor) q.set("cursor", cursor);
      const res = await get(`?${q.toString()}`);
      const body = await res.json();
      for (const e of body.data) seen.push(e.id);
      expect(body.meta.has_more).toBe(seen.length < 5);
      if (!body.meta.has_more) {
        expect(body.meta.next_cursor).toBeUndefined();
        cursor = null;
        break;
      }
      cursor = body.meta.next_cursor;
    }
    expect(seen).toEqual([2, 4, 5, 3, 1]);
    expect(cursor).toBeNull();
  });

  it("sorts ascending and keeps stable id ordering for equal keys", async () => {
    mockLedger(ledger);

    const res = await get("?limit=4&sort_by=timestamp&direction=asc");
    const body = await res.json();
    // asc timestamps: 1(1700000001), 3(1700000003), 5(1700000005),
    // then the 2&4 tie (1700000050) tiebroken by id ascending.
    expect(body.data.map((e: AuditEntry) => e.id)).toEqual([1, 3, 5, 2]);
  });

  it("sorts by allowlisted string field (action)", async () => {
    mockLedger(ledger);

    const res = await get("?limit=2&sort_by=action&direction=asc");
    const body = await res.json();
    expect(body.data.map((e: AuditEntry) => e.id)).toEqual([1, 3]); // payment_recorded first
  });

  it("rejects a non-allowlisted sort field", async () => {
    mockLedger(ledger);

    const res = await get("?sort_by=details");
    expect(res.status).toBe(400);
  });

  it("rejects a tampered cursor with 400", async () => {
    mockLedger(ledger);

    const res = await get("?cursor=!!!not-base64!!!");
    expect(res.status).toBe(400);
  });

  it("respects filters while cursor-paginating", async () => {
    mockLedger(ledger);

    const res = await get("?action=role_granted&limit=1&sort_by=timestamp&direction=desc");
    const body = await res.json();
    expect(body.data.map((e: AuditEntry) => e.id)).toEqual([2]);
    expect(body.meta.has_more).toBe(true);
    expect(body.meta.total).toBe(2);

    const cur = decodeAuditCursor(body.meta.next_cursor)!;
    expect(cur.id).toBe("2");
    expect(JSON.parse(cur.k)).toBe(1700000050);
  });

  it("round-trips cursors through encode/decode", () => {
    const token = encodeAuditCursor({ k: JSON.stringify(42), id: "7" });
    expect(decodeAuditCursor(token)).toEqual({ k: "42", id: "7" });
    expect(decodeAuditCursor("garbage")).toBeNull();
  });

  it("caps limit at the maximum of 100", async () => {
    mockLedger(ledger);

    const res = await get("?limit=500");
    expect(res.status).toBe(400);
  });
});

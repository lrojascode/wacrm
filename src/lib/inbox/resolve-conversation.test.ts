import { describe, expect, it, vi } from "vitest";

import {
  looksLikeConversationId,
  resolveConversation,
} from "./resolve-conversation";

/** Minimal stand-in for the query chain `resolveConversation` uses. */
function clientReturning(
  result: { data?: unknown; error?: unknown },
  { signedIn = true }: { signedIn?: boolean } = {},
) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  return {
    client: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: signedIn ? { id: "u1" } : null } }),
      },
    } as never,
    maybeSingle,
  };
}

const ROW = {
  id: "c0000000-0000-4000-8000-000000000001",
  account_id: "a1",
  user_id: "u1",
  contact_id: "b1",
  status: "open",
  unread_count: 0,
  contact: { id: "b1", name: "Ana", phone: "+51900000001" },
};

describe("resolveConversation", () => {
  it("devuelve ok con la conversación normalizada", async () => {
    const { client } = clientReturning({ data: ROW, error: null });

    const result = await resolveConversation(client, ROW.id);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.conversation.id).toBe(ROW.id);
    }
  });

  // RLS devuelve cero filas tanto para una conversación borrada como
  // para una de otra cuenta. Son el mismo resultado a propósito: ver la
  // cabecera de resolve-conversation.ts.
  it("devuelve unavailable cuando no hay fila y la sesión sigue viva", async () => {
    const { client } = clientReturning({ data: null, error: null });

    expect(await resolveConversation(client, ROW.id)).toEqual({
      status: "unavailable",
    });
  });

  // Sin sesión, RLS devuelve cero filas SIN error, exactamente igual
  // que para una conversación inaccesible. Confundirlas hacía que una
  // sesión moribunda se anunciara como "conversación eliminada", y que
  // el `?next=` acabara apuntando a la lista en vez de al hilo que el
  // usuario estaba leyendo.
  it("distingue una sesión ausente de una conversación inaccesible", async () => {
    const { client } = clientReturning({ data: null, error: null }, { signedIn: false });

    expect(await resolveConversation(client, ROW.id)).toEqual({
      status: "unauthenticated",
    });
  });

  // La distinción que evita repetir el error que P0-BUG-03 corrigió:
  // un fallo de consulta NO es evidencia de que la conversación no
  // exista, así que no debe expulsar al usuario.
  it("distingue un fallo de consulta de una conversación inaccesible", async () => {
    const { client } = clientReturning({
      data: null,
      error: { message: "Failed to fetch" },
    });

    const result = await resolveConversation(client, ROW.id);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("Failed to fetch");
    }
  });

  it("captura una excepción del cliente como error, no como unavailable", async () => {
    const client = {
      from: () => {
        throw new Error("network down");
      },
    } as never;

    const result = await resolveConversation(client, ROW.id);

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toBe("network down");
    }
  });
});

describe("looksLikeConversationId", () => {
  it("acepta un uuid", () => {
    expect(looksLikeConversationId("c0000000-0000-4000-8000-000000000001")).toBe(true);
    expect(looksLikeConversationId("C0000000-0000-4000-8000-000000000001")).toBe(true);
  });

  // Un id mal formado hace que PostgREST rechace la consulta con un
  // error de cast, que se leería como fallo de transporte y dejaría al
  // usuario esperando un hilo que nunca carga.
  it("rechaza lo que no lo es", () => {
    expect(looksLikeConversationId("no-soy-un-uuid")).toBe(false);
    expect(looksLikeConversationId("")).toBe(false);
    expect(looksLikeConversationId("c0000000-0000-4000-8000")).toBe(false);
    expect(looksLikeConversationId("../../etc/passwd")).toBe(false);
    expect(
      looksLikeConversationId("c0000000-0000-4000-8000-000000000001 OR 1=1"),
    ).toBe(false);
  });
});

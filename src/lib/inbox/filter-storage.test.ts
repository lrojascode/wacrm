import { describe, expect, it } from "vitest";

import {
  EMPTY_FILTER_STATE,
  inboxFilterStorageKey,
  isEmptyFilterState,
  parseInboxFilterState,
  type InboxFilterState,
} from "./filter-storage";

const FULL: InboxFilterState = {
  search: "Ana",
  filter: "unread",
  selectedTagIds: ["t1", "t2"],
  selectedCompany: "Acme",
};

describe("inboxFilterStorageKey", () => {
  // Sin la cuenta en la clave, dos personas que comparten perfil de
  // navegador —o una que salta entre sus propias cuentas— heredarían
  // los filtros de la otra. Un filtro heredado esconde conversaciones
  // en silencio, que es justo lo que se reporta como "faltan mensajes".
  it("separa el estado por cuenta", () => {
    expect(inboxFilterStorageKey("a1")).not.toBe(inboxFilterStorageKey("a2"));
    expect(inboxFilterStorageKey("a1")).toContain("a1");
  });
});

describe("parseInboxFilterState", () => {
  it("recupera un estado completo", () => {
    expect(parseInboxFilterState(JSON.stringify(FULL))).toEqual(FULL);
  });

  it("devuelve el estado vacío cuando no hay nada", () => {
    expect(parseInboxFilterState(null)).toEqual(EMPTY_FILTER_STATE);
    expect(parseInboxFilterState("")).toEqual(EMPTY_FILTER_STATE);
  });

  it("sobrevive a un valor corrupto", () => {
    expect(parseInboxFilterState("{no es json")).toEqual(EMPTY_FILTER_STATE);
    expect(parseInboxFilterState("null")).toEqual(EMPTY_FILTER_STATE);
    expect(parseInboxFilterState('"una cadena"')).toEqual(EMPTY_FILTER_STATE);
    expect(parseInboxFilterState("[]")).toEqual(EMPTY_FILTER_STATE);
  });

  // Un filtro inválido no casaría con ninguna conversación, y el usuario
  // vería su bandeja vacía sin entender por qué.
  it("descarta un filtro que no existe", () => {
    const parsed = parseInboxFilterState(
      JSON.stringify({ ...FULL, filter: "inventado" }),
    );
    expect(parsed.filter).toBe("all");
    // El resto del estado se conserva.
    expect(parsed.search).toBe("Ana");
  });

  it("narra campo a campo lo que venga con el tipo equivocado", () => {
    const parsed = parseInboxFilterState(
      JSON.stringify({
        search: 42,
        filter: "open",
        selectedTagIds: ["ok", 7, null],
        selectedCompany: { nope: true },
      }),
    );
    expect(parsed).toEqual({
      search: "",
      filter: "open",
      selectedTagIds: ["ok"],
      selectedCompany: null,
    });
  });
});

describe("isEmptyFilterState", () => {
  it("reconoce el estado sin filtros", () => {
    expect(isEmptyFilterState(EMPTY_FILTER_STATE)).toBe(true);
  });

  it("cualquier filtro puesto cuenta como no vacío", () => {
    expect(isEmptyFilterState({ ...EMPTY_FILTER_STATE, search: "x" })).toBe(false);
    expect(isEmptyFilterState({ ...EMPTY_FILTER_STATE, filter: "unread" })).toBe(false);
    expect(isEmptyFilterState({ ...EMPTY_FILTER_STATE, selectedTagIds: ["t"] })).toBe(false);
    expect(isEmptyFilterState({ ...EMPTY_FILTER_STATE, selectedCompany: "Acme" })).toBe(false);
  });
});

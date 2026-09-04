/**
 * Comisión bancaria de un cobro — REGLA ÚNICA (memoria "comisión bancaria en
 * cobros"): `monto` es siempre el BRUTO que pagó el cliente; el banco
 * deposita `monto − comisión` (neto por diferencia, nunca se guarda). La
 * comisión puede venir como MONTO directo (el estado de cuenta trae pesos,
 * no %) — manda sobre el % y el % se deriva solo como referencia — o como %
 * (se calcula el monto). Misma aritmética en el cobro por vuelo
 * (`createCobro`) y en el SOBRE de grupo (4-sep-2026): jamás replicarla.
 */
export interface ComisionBancariaResuelta {
  /** % de referencia (4 decimales) o null sin comisión. */
  pct: number | null;
  /** Monto de comisión en la moneda del cobro (2 decimales) o null. */
  monto: number | null;
  /** true cuando la comisión iguala o supera el monto: el caller responde 400. */
  excede: boolean;
}

export function resolverComisionBancaria(
  monto: number,
  pct?: number | null,
  montoDirecto?: number | null,
): ComisionBancariaResuelta {
  const directo =
    Number(montoDirecto) > 0
      ? Math.round(Number(montoDirecto) * 100) / 100
      : null;
  const pctFinal = directo
    ? Math.round((directo / monto) * 100 * 10000) / 10000
    : Number(pct) > 0
      ? Number(pct)
      : null;
  const montoFinal =
    directo ??
    (pctFinal ? Math.round(monto * (pctFinal / 100) * 100) / 100 : null);
  return {
    pct: pctFinal,
    monto: montoFinal,
    excede: montoFinal != null && montoFinal >= monto,
  };
}

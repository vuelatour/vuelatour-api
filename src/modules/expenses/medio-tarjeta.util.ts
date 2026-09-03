/**
 * Medio de pago ↔ terminación de tarjeta ↔ lectura IA del comprobante.
 * Helpers PUROS (3-sep-2026): fuente única de `expenses.service` para
 * create, update y el enriquecimiento IA al sincronizar.
 *
 * Regla de BD (migración 20260515000001, CHECK `gasto_check` / código
 * 23514): `tarjeta_terminacion` son 4 dígitos y SOLO vive con
 * `medio_pago = 'TARJETA_CORP'`. Todo escritor de la columna pasa por aquí
 * para que ese CHECK jamás reviente en silencio (caso reporte 3-sep: un
 * gasto EFECTIVO con voucher de tarjeta tiraba TODO el enriquecimiento
 * offline con un simple warn, y un PATCH que cambiaba el medio respondía
 * 500).
 *
 * Principio: el MEDIO lo elige el humano (la app y el panel ya no
 * preseleccionan ninguno) y la IA JAMÁS lo reescribe; toda diferencia
 * IA-vs-captura se vuelve una discrepancia legible para que oficina decida.
 */

export const MEDIO_TARJETA_CORP = 'TARJETA_CORP';

/** Medios de "bolsillo": efectivo del fondo y reintegros personales — no
 *  pasan por el banco, así que un voucher bancario en su comprobante es
 *  sospechoso. */
export const MEDIOS_NO_BANCARIOS: ReadonlySet<string> = new Set([
  'EFECTIVO',
  'PERSONAL_PABLO',
  'PERSONAL_ALE',
]);

/** Medios que la IA distingue en un voucher/comprobante como pago bancario
 *  (`GastoTicketVisionResult.medio_pago`). */
export const MEDIOS_IA_BANCARIOS: ReadonlySet<string> = new Set([
  'TARJETA_CORP',
  'TRANSFERENCIA',
]);

const MEDIO_LABEL: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA_CORP: 'Tarjeta corporativa',
  TRANSFERENCIA: 'Transferencia',
  PAYWISE: 'PayWise',
  PERSONAL_PABLO: 'Personal Pablo',
  PERSONAL_ALE: 'Personal Ale',
  BODEGA: 'Bodega',
};

/** Etiqueta legible del medio (reportes y avisos los lee gente de oficina). */
export function etiquetaMedioPago(medio: string | null | undefined): string {
  if (!medio) return '—';
  return MEDIO_LABEL[medio] ?? medio;
}

/** Terminación válida para la BD: exactamente 4 dígitos. */
export function esTerminacionValida(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}$/.test(v);
}

/** Terminación que la IA leyó en el voucher (`valor_ia_extraido`), si es
 *  válida; null en cualquier otro caso (jsonb ajeno, formato raro…). */
export function terminacionIa(valorIa: unknown): string | null {
  const t = (valorIa as { tarjeta_terminacion?: unknown } | null | undefined)
    ?.tarjeta_terminacion;
  return esTerminacionValida(t) ? t : null;
}

/** Medio que la IA leyó en el voucher, si es una cadena. */
function medioIa(valorIa: unknown): string | null {
  const m = (valorIa as { medio_pago?: unknown } | null | undefined)
    ?.medio_pago;
  return typeof m === 'string' && m.trim() ? m : null;
}

export interface TerminacionPrevia {
  /** Valor ya decidido (null = sin tarjeta; fuera de TARJETA_CORP SIEMPRE
   *  null porque el CHECK lo exige). */
  terminacion: string | null;
  /** true = TARJETA_CORP sin terminación explícita ni de IA: el llamador
   *  debe buscar la tarjeta ASIGNADA al capturador en el catálogo. */
  buscarAsignada: boolean;
}

/**
 * Paso PURO del sello de tarjeta ("TARJETA CORP por detrás", 26-ago): el
 * usuario solo elige "Tarjeta corporativa" y la terminación se resuelve en
 * este orden: (1) valor explícito del cliente (oficina / APK viejo con
 * selector), (2) la que la IA leyó en el VOUCHER (máxima fidelidad: es la
 * tarjeta que de verdad pagó), (3) la asignada al capturador — esa la busca
 * el llamador cuando `buscarAsignada` es true. Con cualquier otro medio la
 * terminación es null, venga lo que venga.
 */
export function terminacionPrevia(
  medio: string | null | undefined,
  explicita: unknown,
  valorIa: unknown,
): TerminacionPrevia {
  if (medio !== MEDIO_TARJETA_CORP) {
    return { terminacion: null, buscarAsignada: false };
  }
  if (typeof explicita === 'string' && explicita.trim()) {
    return { terminacion: explicita.trim(), buscarAsignada: false };
  }
  const ia = terminacionIa(valorIa);
  if (ia) return { terminacion: ia, buscarAsignada: false };
  return { terminacion: null, buscarAsignada: true };
}

export type AcopleTarjeta = 'limpiar' | 'sellar' | 'nada';

/**
 * Acoplamiento medio↔tarjeta en un PATCH: qué hacer con `tarjeta_terminacion`
 * según el medio que llega.
 * - medio ausente → nada (el PATCH no toca el medio);
 * - medio ≠ TARJETA_CORP → LIMPIAR (el CHECK exige null; antes: 500);
 * - TARJETA_CORP con terminación explícita → nada (ya viaja en el PATCH);
 * - TARJETA_CORP sin terminación y el gasto ya tenía una → nada (se conserva);
 * - TARJETA_CORP sin terminación en ningún lado → SELLAR (IA → catálogo).
 */
export function acoplarTarjetaEnUpdate(
  dto: { medio_pago?: string | null; tarjeta_terminacion?: string | null },
  actual: { tarjeta_terminacion?: string | null } | null | undefined,
): AcopleTarjeta {
  if (dto.medio_pago === undefined || dto.medio_pago === null) return 'nada';
  if (dto.medio_pago !== MEDIO_TARJETA_CORP) return 'limpiar';
  if (dto.tarjeta_terminacion) return 'nada';
  if (dto.tarjeta_terminacion === undefined && actual?.tarjeta_terminacion) {
    return 'nada';
  }
  return 'sellar';
}

export interface CruceMedioIa {
  /** Terminación que conviene sellar (solo con TARJETA_CORP y hueco vacío). */
  sellarTerminacion: string | null;
  /** Texto ⚠ para notas/aviso (sin el prefijo "⚠ … — revisar"). */
  discrepancia: string | null;
}

/**
 * Cruce de lo CAPTURADO (medio + tarjeta) contra lo que la IA leyó en el
 * comprobante. NUNCA propone reescribir el medio: lo eligió el humano.
 * - TARJETA_CORP: llena la terminación si falta; si difiere, discrepancia.
 * - Medio de bolsillo (EFECTIVO / PERSONAL_*) con voucher bancario (medio
 *   IA tarjeta/transferencia o una terminación leída): discrepancia
 *   "medio capturado Efectivo, el voucher parece pago con tarjeta •1234".
 * - TRANSFERENCIA / PAYWISE / BODEGA: nada (la conciliación bancaria decide).
 */
export function cruzarMedioConIa(
  capturado: {
    medio_pago: string | null | undefined;
    tarjeta_terminacion: string | null | undefined;
  },
  ia: unknown,
): CruceMedioIa {
  const nada: CruceMedioIa = { sellarTerminacion: null, discrepancia: null };
  if (!ia || typeof ia !== 'object') return nada;
  const iaTerm = terminacionIa(ia);
  const iaMedio = medioIa(ia);
  const medio = capturado.medio_pago ?? null;
  if (medio === MEDIO_TARJETA_CORP) {
    const actual = capturado.tarjeta_terminacion || null;
    if (!actual && iaTerm) return { ...nada, sellarTerminacion: iaTerm };
    if (actual && iaTerm && actual !== iaTerm) {
      return {
        ...nada,
        discrepancia: `tarjeta capturada •${actual}, el voucher dice •${iaTerm}`,
      };
    }
    return nada;
  }
  if (medio && MEDIOS_NO_BANCARIOS.has(medio)) {
    const bancarioIa = iaMedio !== null && MEDIOS_IA_BANCARIOS.has(iaMedio);
    if (!bancarioIa && !iaTerm) return nada;
    const tipo =
      iaMedio === 'TRANSFERENCIA' && !iaTerm ? 'transferencia' : 'tarjeta';
    return {
      ...nada,
      discrepancia: `medio capturado ${etiquetaMedioPago(medio)}, el voucher parece pago con ${tipo}${iaTerm ? ` •${iaTerm}` : ''}`,
    };
  }
  return nada;
}

/**
 * Mensaje legible para una violación de CHECK (23514) al escribir `gasto`.
 * Se responde 409 (nunca 500: un 500 dispara el reintento del outbox de la
 * app y el error se repetiría igual).
 */
export function mensajeCheckGasto(error: {
  message?: string | null;
  details?: string | null;
}): string {
  const texto = `${error.message ?? ''} ${error.details ?? ''}`;
  // `\bgasto_check\b`: el CHECK de tabla medio↔tarjeta (no `gasto_tc_gasto_check`).
  if (/tarjeta_terminacion|\bgasto_check\b/.test(texto)) {
    return 'La terminación de tarjeta solo aplica con el medio Tarjeta corporativa y debe ser de 4 dígitos: revisa el medio de pago y la tarjeta.';
  }
  if (/propina/.test(texto)) return 'La propina no puede ser negativa.';
  if (/monto/.test(texto)) return 'El monto debe ser mayor que cero.';
  if (/tc_gasto/.test(texto)) {
    return 'El tipo de cambio del gasto debe ser mayor que cero.';
  }
  const m = /constraint "([^"]+)"/.exec(texto);
  return `El gasto no cumple una regla de la base de datos${m ? ` (${m[1]})` : ''}: revisa los datos capturados.`;
}

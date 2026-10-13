/**
 * PRE-CIERRE → «Vuelos cobrados en cuentas que exigen factura sin factura
 * registrada» (13-oct-2026, decisión 4 del lote del cliente, invariante 60).
 *
 * Un cobro que entra a HSBC Dólares / HSBC Pesos / Scotiabank Dólares /
 * Scotiabank Pesos (o por link de pago HSBC, transferencia o cheque sin
 * cuenta capturada) EXIGE factura del servicio al cliente (regla única en
 * `common/cuentas-cobro.ts`). Este renglón lista, de los vuelos del periodo
 * (por `fecha_vuelo`, cortes Cancún, TODOS los estados que ya lee el
 * pre-cierre: pendientes, completados y cancelados — el dinero retenido en
 * HSBC también se factura), los que exigen factura y NO tienen una
 * registrada (CFDI vivo, emitida VIGENTE, folio o estatus manual). La
 * solicitud viva («Por facturar») NO lo mete ni lo saca: `solicitada` solo
 * informa. Externos y sin avión entran (`matricula` null).
 *
 * Aviso NO bloqueante (`bloqueantes`/`listo` no cambian). Un cobro en HSBC
 * registrado DESPUÉS de cerrar el mes ya no aparece aquí: lo cubre la
 * solicitud automática (bandeja «Por facturar»).
 *
 * Helpers PUROS: la lectura (`facturasDeVuelos`) vive en
 * `profit-sharing.service`; aquí solo el filtro, el shape y el orden.
 */
import type { FacturaDeVuelo } from '../flights/factura-cliente-etiquetas';

export const CLAVE_PRECIERRE_VUELOS_SIN_FACTURA = 'vuelos_cobrados_sin_factura';

export const TITULO_PRECIERRE_VUELOS_SIN_FACTURA =
  'Vuelos cobrados en cuentas que exigen factura sin factura registrada';

export const DETALLE_PRECIERRE_VUELOS_SIN_FACTURA =
  'Cobros que entraron a HSBC Dólares, HSBC Pesos, Scotiabank Dólares o Scotiabank Pesos (o por link de pago HSBC, transferencia o cheque sin cuenta capturada) en vuelos del periodo que no tienen factura del servicio registrada. Regístrala en Facturas emitidas (o pídela desde el vuelo); si el cobro entró a otra cuenta, corrígelo en el detalle del vuelo. No bloquea el cierre.';

/** Texto cuando la lectura FALLÓ: el 0 no significa «no hay». */
export const DETALLE_PRECIERRE_VUELOS_SIN_FACTURA_FALLIDA =
  'No se pudo verificar qué vuelos cobrados en cuentas que exigen factura siguen sin factura registrada: revisa Facturas emitidas → Por facturar antes de cerrar.';

/** Vuelo del periodo tal como lo lee el pre-cierre (cualquier estado). */
export interface VueloCobradoRow {
  id?: unknown;
  folio?: unknown;
  fecha_vuelo?: unknown;
  aeronave_id?: unknown;
}

/** Chip del checklist (mismo shape que los demás + lo propio de la factura). */
export interface VueloCobradoSinFactura {
  id: string;
  folio: number;
  fecha_vuelo: string | null;
  matricula: string | null;
  /** Ya hay solicitud viva «Por facturar» (solo informa). */
  solicitada: boolean;
  /** Cuentas (texto) de los cobros que exigen factura, distintas. */
  cuentas: string[];
}

/**
 * Los vuelos con exigencia `EXIGE` y SIN factura registrada, ordenados por
 * `fecha_vuelo` (empate por folio; sin fecha, al final) — misma función de
 * orden que `vuelos-sin-gasto.util`.
 */
export function vuelosCobradosSinFactura(args: {
  vuelos: ReadonlyArray<VueloCobradoRow>;
  facturas: ReadonlyMap<string, FacturaDeVuelo>;
  /** aeronave.id → matrícula (lo que no resuelva sale `null`). */
  matriculas: ReadonlyMap<string, string>;
}): VueloCobradoSinFactura[] {
  const out: VueloCobradoSinFactura[] = [];
  const vistos = new Set<string>();
  for (const v of args.vuelos) {
    if (typeof v.id !== 'string' || !v.id || vistos.has(v.id)) continue;
    vistos.add(v.id);
    const f = args.facturas.get(v.id);
    if (!f || f.exigencia !== 'EXIGE' || f.registrada != null) continue;
    out.push({
      id: v.id,
      folio: Number(v.folio ?? 0),
      fecha_vuelo: typeof v.fecha_vuelo === 'string' ? v.fecha_vuelo : null,
      matricula:
        typeof v.aeronave_id === 'string'
          ? (args.matriculas.get(v.aeronave_id) ?? null)
          : null,
      solicitada: f.solicitada,
      cuentas: [...f.cuentas_exigen],
    });
  }
  const ms = (f: string | null) => {
    const t = f ? Date.parse(f) : NaN;
    return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
  };
  return out.sort(
    (a, b) => ms(a.fecha_vuelo) - ms(b.fecha_vuelo) || a.folio - b.folio,
  );
}

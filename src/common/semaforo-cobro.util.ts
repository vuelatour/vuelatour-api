/**
 * SEMÁFORO DE COBRO — espejo server-side de `estadoCobroSemaforo` del panel
 * (`vuelatour-next/src/lib/admin/cobros.ts`), 8-sep-2026.
 *
 * El panel es el ORIGINAL (listas de vuelos/cotizaciones y detalle); esta
 * copia existe para los documentos que pinta pyservices (PDF «Cotización
 * interna»), que no pueden importar el panel. Misma taxonomía acordada con
 * el cliente: Cobrado / Parcial (con abonos) / Sin cobro; "no aplica" para
 * filas sin precio, cotización abierta, interno, cancelado o aún en
 * cotización. Misma tolerancia de redondeo multi-moneda que
 * `refreshCobradoFlag` y el panel (caso #131): hasta 1 USD es redondeo, no
 * deuda. Si cambia una regla aquí, cambia también en el panel (y viceversa).
 *
 * Los INSUMOS vienen de las fuentes únicas: `montoTotalUsd` =
 * `vuelo.monto_total_usd`, `totalCobradoUsd`/`sinTcCount` = `cobrosEnUsd`,
 * `cobrado` = bandera del vuelo. Aquí no se suma dinero.
 */

export const TOLERANCIA_COBRO_USD = 1;

export type EstadoCobroKey = 'COBRADO' | 'PARCIAL' | 'SIN_COBROS' | 'NO_APLICA';

/** Color del semáforo para documentos (pyservices pinta el punto). */
export type ColorSemaforoCobro = 'verde' | 'amarillo' | 'rojo' | 'gris';

export interface EstadoCobroSemaforo {
  key: EstadoCobroKey;
  label: string;
  color: ColorSemaforoCobro;
  title?: string;
}

const COLOR_POR_KEY: Record<EstadoCobroKey, ColorSemaforoCobro> = {
  COBRADO: 'verde',
  PARCIAL: 'amarillo',
  SIN_COBROS: 'rojo',
  NO_APLICA: 'gris',
};

/** Pendiente REAL: 0 si lo que falta cabe en la tolerancia de redondeo. */
export function pendienteCobro(totalUsd: number, cobradoUsd: number): number {
  const p = Math.round((totalUsd - cobradoUsd) * 100) / 100;
  return p > TOLERANCIA_COBRO_USD ? p : 0;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function estadoCobroSemaforo(v: {
  montoTotalUsd: number;
  cobrado: boolean;
  /** null = sin lote de cobros disponible: se degrada a "Por cobrar". */
  totalCobradoUsd: number | null;
  sinTcCount?: number;
  cotizacionAbierta?: boolean;
  /** SOLICITUD/COTIZADO: aún no hay nada que cobrar. */
  enCotizacion?: boolean;
  cancelado?: boolean;
  /** Cliente interno: cotiza $0 a propósito (no es "sin precio"). */
  esInterno?: boolean;
}): EstadoCobroSemaforo {
  const con = (
    key: EstadoCobroKey,
    label: string,
    title?: string,
  ): EstadoCobroSemaforo => ({
    key,
    label,
    color: COLOR_POR_KEY[key],
    ...(title ? { title } : {}),
  });
  const avisoSinTc =
    (v.sinTcCount ?? 0) > 0
      ? ` · ⚠ ${v.sinTcCount} cobro(s) en MXN sin TC no suman: captura el TC`
      : '';
  if (v.cotizacionAbierta) {
    return con(
      'NO_APLICA',
      'Abierta',
      'Cotización abierta: el precio se cierra al final del viaje',
    );
  }
  // $0 NUNCA es cobrado ni deuda (gate del API, caso #38): internos,
  // reservas sin cotizar, solicitudes.
  if (!(v.montoTotalUsd > 0)) {
    if (v.esInterno) {
      return con(
        'NO_APLICA',
        'Interno',
        'Cliente interno: cotiza $0 a propósito (solo pesa en el balance del avión)',
      );
    }
    return con('NO_APLICA', 'Sin precio');
  }
  if (v.cobrado) return con('COBRADO', 'Cobrado');
  const cobradoUsd = v.totalCobradoUsd;
  // Cancelado ANTES de "Parcial": un ámbar invitaría a cobrar el saldo de
  // un vuelo que ya no existe — el dinero vivo lo vigila el pre-cierre.
  if (v.cancelado) {
    if (cobradoUsd != null && cobradoUsd > 0) {
      return con(
        'NO_APLICA',
        'Con cobros',
        `Vuelo cancelado con $${fmt(cobradoUsd)} USD cobrados (cargo por cancelación; el pre-cierre lo vigila)`,
      );
    }
    return con('NO_APLICA', '—', 'Vuelo cancelado sin cobros');
  }
  if (cobradoUsd != null && cobradoUsd > 0) {
    // Flag `cobrado` desfasado: si lo que falta cabe en la tolerancia de
    // redondeo, es cobrado, no parcial (fuente única, caso #131).
    if (pendienteCobro(v.montoTotalUsd, cobradoUsd) === 0) {
      return con('COBRADO', 'Cobrado');
    }
    return con(
      'PARCIAL',
      'Parcial',
      `Cobrado $${fmt(cobradoUsd)} de $${fmt(v.montoTotalUsd)} USD${avisoSinTc}`,
    );
  }
  // Hay cobros pero TODOS en MXN sin TC (no convierten): es dinero
  // capturado, no "sin cobro" — mismo criterio que el filtro PARCIAL.
  if (cobradoUsd != null && (v.sinTcCount ?? 0) > 0) {
    return con(
      'PARCIAL',
      'Parcial',
      `Cobros en MXN sin TC: no se pueden convertir a USD${avisoSinTc}`,
    );
  }
  if (v.enCotizacion) {
    return con('NO_APLICA', '—', 'Aún en cotización');
  }
  if (cobradoUsd == null) {
    // Sin el lote no se distingue parcial de cero: paraguas del filtro.
    return con('SIN_COBROS', 'Por cobrar', avisoSinTc || undefined);
  }
  return con(
    'SIN_COBROS',
    'Sin cobro',
    `Total $${fmt(v.montoTotalUsd)} USD sin ningún cobro${avisoSinTc}`,
  );
}

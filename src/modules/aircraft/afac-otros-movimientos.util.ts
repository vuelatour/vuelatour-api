import type {
  BalanceAfacOtrosMovimientosPayload,
  BalanceAvionPayload,
} from '../pyservices/pyservices.service';

/**
 * Bloque «PERMISOS AFAC» de la pestaña «otros movimientos» del Balance
 * general (12-oct-2026, API 0.0.69, invariante 53). Pedido de Ale: «en el
 * balance general en la página de otros movimientos no se ven los AFAC,
 * aquí deben estar también».
 *
 * INFORMATIVO, por diseño: la provisión de cada vuelo YA resta en su avión
 * (columna PERMISO AFAC (PROVISIÓN) de la hoja de vuelos, invariante 3 de
 * los libros) y los permisos pagados (gastos PERMISO) ya restan en la hoja
 * «permisos» de cada libro individual. Aquí solo se ven JUNTOS —cuánto se
 * provisionó en el periodo y cuánto se pagó— sin entrar a los totales de la
 * pestaña ni al bloque VUELATOUR de «balance»: si entraran, se contarían
 * dos veces. PURO: suma lo que los libros ya traen; no recalcula una
 * provisión.
 */
const r2 = (x: number): number => Math.round(x * 100) / 100;

export function bloqueAfacOtrosMovimientos(
  libros: ReadonlyArray<
    Pick<
      BalanceAvionPayload,
      'matricula' | 'permiso_afac_usd_hr' | 'vuelos' | 'totales' | 'permisos'
    >
  >,
): BalanceAfacOtrosMovimientosPayload | undefined {
  const provision: BalanceAfacOtrosMovimientosPayload['provision'] = [];
  const pagados: BalanceAfacOtrosMovimientosPayload['pagados'] = [];
  for (const p of libros) {
    const monto = r2(Number(p.totales?.permiso_afac_mxn) || 0);
    const vuelos = p.vuelos.filter(
      (v) => (Number(v.permiso_afac_mxn) || 0) !== 0,
    ).length;
    const filasPermisos = p.permisos?.filas ?? [];
    if (monto !== 0 || vuelos > 0) {
      provision.push({
        matricula: p.matricula,
        tarifa_usd_hr: p.permiso_afac_usd_hr ?? null,
        vuelos,
        monto_mxn: monto,
      });
    }
    for (const f of filasPermisos) {
      pagados.push({
        matricula: p.matricula,
        fecha: f.fecha ?? null,
        detalle: f.detalle,
        monto_mxn: f.monto_mxn ?? null,
      });
    }
  }
  if (provision.length === 0 && pagados.length === 0) return undefined;
  const provisionTotal = r2(provision.reduce((acc, x) => acc + x.monto_mxn, 0));
  const pagadosTotal = r2(
    pagados.reduce((acc, x) => acc + (x.monto_mxn ?? 0), 0),
  );
  return {
    provision,
    provision_total_mxn: provisionTotal,
    pagados,
    pagados_total_mxn: pagadosTotal,
    remanente_mxn: r2(provisionTotal - pagadosTotal),
  };
}

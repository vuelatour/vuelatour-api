/**
 * PARTICIÓN DEL INGRESO DE UN VUELO — fuente única (regla del cliente,
 * 28-ago-2026).
 *
 * El precio que paga el cliente (`vuelo.monto_total_usd`) tiene dos dueños:
 *
 *   • VENTA DEL AVIÓN  = tiempo de vuelo (tarifa × horas cobradas) + ajuste /
 *     descuento + comisión del vendedor + el IVA proporcional de esas tres
 *     partes. Es lo que entra al balance por avión y al reparto de dueños.
 *     (La comisión del vendedor conserva su tratamiento del 23-jul: viaja
 *     dentro de la venta y cada lector la descuenta como costo — neto del
 *     avión = precio base.)
 *
 *   • INGRESO DE VUELATOUR = TUAS + extras + viáticos de pernocta cobrados +
 *     su IVA (+ los centavos de redondeo). NO es venta del avión: vive solo en
 *     la pestaña "Otros movimientos" del Balance general, apareado con lo que
 *     se pagó (TUA al aeropuerto, hotel, comisión BillPocket…).
 *
 * Disciplina v1.3: el avión se calcula con las líneas del desglose canónico
 * (`calculo_snapshot.desglose`) y la parte de VuelaTour se CIERRA POR
 * DIFERENCIA contra el total, así `avion_usd + vuelatour_usd == total_usd`
 * al centavo SIEMPRE. Sin desglose (vuelos previos al motor v1.3 o externos
 * rápidos) se usan las columnas persistidas del vuelo con la misma fórmula.
 *
 * TODOS los lectores (balance por avión, reparto, Libro Dinero, reporte por
 * vuelo) deben usar esta función — jamás recalcular la partición a mano.
 */

export interface VueloIngresoInput {
  monto_total_usd?: number | string | null;
  subtotal_vuelo_usd?: number | string | null;
  ajuste_final_usd?: number | string | null;
  comision_vendedor_usd?: number | string | null;
  iva_usd?: number | string | null;
  iva_pct?: number | string | null;
  tuas_usd?: number | string | null;
  extras_total_usd?: number | string | null;
  viaticos_pernocta_usd?: number | string | null;
  /** `vuelo.calculo_snapshot` (jsonb) tal cual viene de la BD. */
  calculo_snapshot?: unknown;
}

export interface ParticionIngreso {
  /** Total cobrado al cliente (= `monto_total_usd`, redondeado a centavos). */
  total_usd: number;
  /** Venta del AVIÓN: tiempo + ajuste + comisión vendedor + IVA proporcional. */
  avion_usd: number;
  /** Ingreso de VUELATOUR: TUAS + extras + pernocta + su IVA (+ residuo). */
  vuelatour_usd: number;
  iva_total_usd: number;
  iva_avion_usd: number;
  iva_vuelatour_usd: number;
  /** Componentes PRE-IVA (informativos, ya redondeados). */
  tiempo_usd: number;
  ajuste_usd: number;
  comision_vendedor_usd: number;
  tuas_usd: number;
  extras_usd: number;
  pernocta_usd: number;
  /**
   * `avion_usd / total_usd` (1 si el total es 0). Sirve para PRORRATEAR un
   * cobro parcial entre el avión y VuelaTour: cobrado × factor = parte del
   * avión — exacto (= avion_usd) cuando el vuelo está pagado completo.
   */
  factor_avion: number;
  fuente: 'desglose' | 'columnas' | 'sin_precio';
  /**
   * true si el desglose no cuadró con el total (la partición cayó al total
   * completo para no inventar dinero). Los lectores lo exponen como pendiente.
   */
  inconsistente: boolean;
}

type LineaDesglose = {
  clave?: unknown;
  concepto?: unknown;
  monto_usd?: unknown;
};

const round2 = (n: number): number =>
  Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const pos = (v: unknown): number | null => {
  const n = num(v);
  return n != null && n > 0 ? n : null;
};

/** iva_pct como fracción (0.16). Tolera capturas en porcentaje (16 → 0.16). */
const ivaFraccion = (v: unknown): number | null => {
  const n = pos(v);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
};

function leerSnapshot(raw: unknown): {
  lineas: LineaDesglose[] | null;
  ivaPct: number | null;
  baseIva: number | null;
  redondeoAuto: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { lineas: null, ivaPct: null, baseIva: null, redondeoAuto: 0 };
  }
  const snap = raw as {
    desglose?: unknown;
    iva?: { porcentaje?: unknown; base_usd?: unknown } | null;
    meta?: { redondeo_auto_usd?: unknown } | null;
  };
  const lineas = Array.isArray(snap.desglose)
    ? (snap.desglose as unknown[]).filter(
        (l): l is LineaDesglose => !!l && typeof l === 'object',
      )
    : null;
  return {
    lineas: lineas && lineas.length > 0 ? lineas : null,
    ivaPct: ivaFraccion(snap.iva?.porcentaje),
    baseIva: pos(snap.iva?.base_usd),
    redondeoAuto: num(snap.meta?.redondeo_auto_usd) ?? 0,
  };
}

/** Partición canónica del ingreso de un vuelo. Ver cabecera del archivo. */
export function particionIngresoVuelo(v: VueloIngresoInput): ParticionIngreso {
  const total = round2(num(v.monto_total_usd) ?? 0);
  const base: ParticionIngreso = {
    total_usd: total,
    avion_usd: 0,
    vuelatour_usd: 0,
    iva_total_usd: 0,
    iva_avion_usd: 0,
    iva_vuelatour_usd: 0,
    tiempo_usd: 0,
    ajuste_usd: 0,
    comision_vendedor_usd: 0,
    tuas_usd: 0,
    extras_usd: 0,
    pernocta_usd: 0,
    factor_avion: 1,
    fuente: 'sin_precio',
    inconsistente: false,
  };
  // Cliente interno / sin precio: no hay nada que partir.
  if (total <= 0) return base;

  const snap = leerSnapshot(v.calculo_snapshot);

  let tiempo: number;
  let ajuste: number;
  let comision: number;
  let ivaTotal: number;
  let ivaAvion: number;
  let tuas: number;
  let extras: number;
  let pernocta: number;
  let fuente: ParticionIngreso['fuente'];
  let inconsistente = false;

  if (snap.lineas) {
    const suma = (clave: string) =>
      round2(
        snap.lineas!.reduce(
          (acc, l) =>
            typeof l.clave === 'string' && l.clave === clave
              ? acc + (num(l.monto_usd) ?? 0)
              : acc,
          0,
        ),
      );
    tiempo = suma('TIEMPO_VUELO');
    ajuste = suma('AJUSTE');
    comision = suma('COMISION_VENDEDOR');
    ivaTotal = suma('IVA');
    tuas = suma('TUAS');
    extras = suma('EXTRA');
    pernocta = suma('PERNOCTA');
    fuente = 'desglose';

    // Las líneas DEBEN sumar el total (disciplina v1.3). Si no cuadran
    // (snapshot editado a mano / motor viejo), no se inventa una partición:
    // todo se atribuye al avión y se marca inconsistente.
    const sumaLineas = round2(
      snap.lineas.reduce((acc, l) => acc + (num(l.monto_usd) ?? 0), 0),
    );
    if (Math.abs(sumaLineas - total) > 0.011) {
      inconsistente = true;
    }

    // IVA proporcional por BASE GRAVABLE. base_usd del motor = subtotal +
    // TUAS + extras gravados + comisión + ajuste PRE-IVA. La línea AJUSTE del
    // desglose mezcla ese ajuste pre-IVA con partes POST-IVA (redondeo
    // automático a $10 o delta al precio pactado) que NO están en la base, y
    // el meta no siempre las separa (pactado → redondeo_auto_usd null). Por
    // eso la parte gravable del avión se DERIVA de la base: base − TUAS −
    // extras gravados == tiempo + comisión + ajuste pre-IVA, sin depender del
    // meta. Sin base (snapshot viejo) cae a tiempo + comisión + (ajuste −
    // redondeo automático).
    if (ivaTotal > 0) {
      const ivaPct = snap.ivaPct ?? ivaFraccion(v.iva_pct) ?? 0.16;
      let prop: number;
      if (snap.baseIva != null && snap.baseIva > 0) {
        const extrasGravados = round2(
          snap.lineas.reduce(
            (acc, l) =>
              l.clave === 'EXTRA' &&
              !(
                typeof l.concepto === 'string' &&
                /\(sin IVA\)\s*$/i.test(l.concepto)
              )
                ? acc + (num(l.monto_usd) ?? 0)
                : acc,
            0,
          ),
        );
        const gravableAvion = round2(snap.baseIva - tuas - extrasGravados);
        prop = round2(ivaTotal * (gravableAvion / snap.baseIva));
      } else {
        const gravableAvion = round2(
          tiempo + comision + round2(ajuste - snap.redondeoAuto),
        );
        prop = round2(gravableAvion * ivaPct);
      }
      ivaAvion = Math.min(ivaTotal, Math.max(0, prop));
    } else {
      ivaAvion = 0;
    }
  } else {
    tiempo = round2(num(v.subtotal_vuelo_usd) ?? 0);
    ajuste = round2(num(v.ajuste_final_usd) ?? 0);
    comision = round2(num(v.comision_vendedor_usd) ?? 0);
    ivaTotal = round2(num(v.iva_usd) ?? 0);
    tuas = round2(num(v.tuas_usd) ?? 0);
    extras = round2(num(v.extras_total_usd) ?? 0);
    pernocta = round2(num(v.viaticos_pernocta_usd) ?? 0);
    fuente = 'columnas';
    // Mismo criterio de cuadre que la rama desglose: las columnas deben
    // representar el total (subtotal + ajuste + comisión + IVA + TUAS +
    // extras + pernocta). Si no (fila editada a mano / importada sin
    // desglose), no se inventa una partición: todo al avión + inconsistente.
    const sumaCols = round2(
      tiempo + ajuste + comision + ivaTotal + tuas + extras + pernocta,
    );
    if (Math.abs(sumaCols - total) > 0.011) {
      inconsistente = true;
    }
    if (ivaTotal > 0) {
      const ivaPct = ivaFraccion(v.iva_pct) ?? 0.16;
      ivaAvion = Math.min(
        ivaTotal,
        Math.max(0, round2((tiempo + ajuste + comision) * ivaPct)),
      );
    } else {
      ivaAvion = 0;
    }
  }

  let avion = round2(tiempo + ajuste + comision + ivaAvion);
  // Cierre por diferencia: TUAS + extras + pernocta + su IVA + centavos.
  let vuelatour = round2(total - avion);
  if (inconsistente || vuelatour < -0.005 || avion < 0) {
    // Nunca inventar dinero: si la partición no cierra, el total completo
    // queda en el avión (comportamiento histórico) y se avisa.
    inconsistente = true;
    avion = total;
    vuelatour = 0;
    ivaAvion = ivaTotal;
  }
  const ivaVuelatour = round2(ivaTotal - ivaAvion);

  return {
    total_usd: total,
    avion_usd: avion,
    vuelatour_usd: vuelatour,
    iva_total_usd: ivaTotal,
    iva_avion_usd: ivaAvion,
    iva_vuelatour_usd: ivaVuelatour,
    tiempo_usd: tiempo,
    ajuste_usd: ajuste,
    comision_vendedor_usd: comision,
    tuas_usd: tuas,
    extras_usd: extras,
    pernocta_usd: pernocta,
    // Sin redondear: así cobrado(=total) × factor == avion exacto tras round2.
    factor_avion: total > 0 ? avion / total : 1,
    fuente,
    inconsistente,
  };
}

/**
 * Parte del AVIÓN de un monto cobrado (USD): prorrateo proporcional. Con el
 * vuelo pagado completo devuelve exactamente `avion_usd`; con pago parcial,
 * la proporción. SOBRECOBRO (regla del cliente 28-ago-2026): lo cobrado por
 * encima del total NO es del avión — va a VuelaTour ("Otros movimientos" del
 * Balance general, como los extras), así que la parte del avión se TOPA en
 * `avion_usd`.
 */
export function cobradoParteAvion(
  cobradoUsd: number,
  p: ParticionIngreso,
): number {
  const parte = round2(cobradoUsd * p.factor_avion);
  return p.total_usd > 0 ? Math.min(parte, p.avion_usd) : parte;
}

/** Exceso cobrado sobre el total del vuelo (sobrecobro); 0 si no lo hay. */
export function sobrecobroUsd(cobradoUsd: number, p: ParticionIngreso): number {
  if (p.total_usd <= 0) return 0;
  return Math.max(0, round2(cobradoUsd - p.total_usd));
}

/** Complemento de `cobradoParteAvion`: lo cobrado que pertenece a VuelaTour. */
export function cobradoParteVuelatour(
  cobradoUsd: number,
  p: ParticionIngreso,
): number {
  return round2(cobradoUsd - cobradoParteAvion(cobradoUsd, p));
}

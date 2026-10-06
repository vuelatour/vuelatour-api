import type {
  BalanceEmpresaBloquePayload,
  BalanceEmpresaParticipacionPayload,
} from '../pyservices/pyservices.service';

/**
 * BLOQUE «VUELATOUR (empresa)» AL FINAL DE LA HOJA «balance» DEL BALANCE
 * GENERAL (6-oct-2026, API 0.0.59). Pedido del cliente con la captura de la
 * hoja: «en la hoja de balance falta, hasta el final, el balance de la
 * empresa VuelaTour». Aritmética PURA (con spec); el servicio solo junta los
 * insumos que el general YA calculó — cero cálculos paralelos:
 *
 *  - PARTICIPACIÓN como socia: el `monto_usd` de los socios `es_empresa` de
 *    cada bloque de avión (utilidad COBRADA × %), tal cual.
 *  - INGRESOS y EGRESOS propios: la hoja «otros movimientos» (filas por
 *    vuelo + sueltas), cada fila de regreso a USD con SU T.C. (el K del
 *    vuelo; una suelta, el T.C. que la convirtió o el oficial del día).
 *  - OTROS GASTOS de la empresa: EXACTAMENTE el TOTAL USD de la hoja «otros
 *    gastos» (total MXN ÷ T.C. promedio de la flota).
 *  - TIENDA: la utilidad de la hoja «inventario» ÷ el mismo T.C. promedio.
 *
 * `null` se PROPAGA (regla del libro): una fila de «otros movimientos» sin
 * T.C., una utilidad de avión vacía o la hoja «otros gastos» sin USD dejan
 * su renglón y el RESULTADO vacíos — jamás un número que omite dinero en
 * silencio. PERSONAL_DUENO ya está fuera de todas las fuentes.
 */

/** Mismo redondeo que el resto del balance. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Número positivo o null (T.C. y divisores). */
function pos(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Número finito o null. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Monto en pesos con 2 decimales es-MX (texto de la nota). */
function fmt(n: number): string {
  return round2(n).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Marca con la que «otros movimientos» rotula un concepto que NO llegó a
 * pesos (USD sin T.C.): «(USD sin TC de venta)», «(parcial: USD sin TC)»,
 * «(USD sin TC)», «(parcial: cobro USD sin TC)», «(USD sin TC — no suma)».
 * Todas comparten «sin TC» (palabra completa, con mayúsculas): ese lado de
 * la fila está INCOMPLETO.
 */
const MARCA_SIN_TC = /\bsin TC\b/;

/** Lo que el bloque necesita de UN libro de avión. */
export interface LibroParaEmpresa {
  matricula: string;
  balance: {
    socios: ReadonlyArray<{
      nombre: string;
      porcentaje: number;
      monto_usd: number | null;
      es_empresa?: boolean;
    }>;
  };
}

/**
 * Socios `es_empresa` de cada libro, en el orden de los bloques de la hoja
 * «balance» (el de `aviones`). Dos vigencias de la empresa en el mismo
 * avión salen como dos renglones (cada una tiene su celda en el bloque).
 */
export function participacionesEmpresa(
  libros: ReadonlyArray<LibroParaEmpresa>,
): BalanceEmpresaParticipacionPayload[] {
  return libros.flatMap((l) =>
    l.balance.socios
      .filter((s) => s.es_empresa === true)
      .map((s) => ({
        matricula: l.matricula,
        socio: s.nombre,
        porcentaje: s.porcentaje,
        monto_usd: s.monto_usd,
      })),
  );
}

/** Una fila de «otros movimientos» con el T.C. con que regresa a USD. */
export interface MovimientoParaEmpresa {
  concepto_ingreso: string | null;
  ingreso_mxn: number | null;
  concepto_egreso: string | null;
  egreso_mxn: number | null;
  /** K del vuelo de la fila; en una suelta, su T.C. (ver el servicio). */
  tc: number | null;
}

/**
 * Empareja las filas de «otros movimientos» con sus T.C. (mismo índice).
 * Distinto número de filas y de T.C. es un error de programación que
 * movería dinero entre filas: se LANZA (jamás se adivina el emparejado).
 */
export function movimientosConTc(
  filas: ReadonlyArray<{
    concepto_ingreso: string | null;
    ingreso_mxn: number | null;
    concepto_egreso: string | null;
    egreso_mxn: number | null;
  }>,
  tcs: ReadonlyArray<number | null>,
  hoja: string,
): MovimientoParaEmpresa[] {
  if (filas.length !== tcs.length) {
    throw new Error(
      `Bloque VUELATOUR: «otros movimientos» (${hoja}) trae ${filas.length} fila(s) y ${tcs.length} T.C. — no se puede convertir a USD`,
    );
  }
  return filas.map((f, i) => ({
    concepto_ingreso: f.concepto_ingreso,
    ingreso_mxn: f.ingreso_mxn,
    concepto_egreso: f.concepto_egreso,
    egreso_mxn: f.egreso_mxn,
    tc: tcs[i],
  }));
}

/** Σ de un lado de «otros movimientos» en USD; `sinTc` = filas incompletas. */
export interface LadoEnUsd {
  usd: number | null;
  sinTc: number;
}

/**
 * Un lado (ingreso o egreso) de todas las filas en USD: Σ (MXN ÷ T.C. de
 * la fila), redondeado al final. Una fila cuyo concepto dice «sin TC» (la
 * hoja no la pudo llevar a pesos, o solo en parte) o con pesos y sin T.C.
 * para regresar a USD deja el lado en `null` (mismo criterio que una hoja
 * de gastos con una fila sin MXN).
 */
export function ladoEnUsd(
  movimientos: ReadonlyArray<MovimientoParaEmpresa>,
  lado: 'ingreso' | 'egreso',
): LadoEnUsd {
  let suma = 0;
  let sinTc = 0;
  for (const m of movimientos) {
    const concepto =
      lado === 'ingreso' ? m.concepto_ingreso : m.concepto_egreso;
    const mxn = lado === 'ingreso' ? m.ingreso_mxn : m.egreso_mxn;
    const tc = pos(m.tc);
    if (concepto != null && MARCA_SIN_TC.test(concepto)) {
      sinTc += 1;
      continue;
    }
    if (mxn == null || mxn === 0) continue;
    if (tc == null) {
      sinTc += 1;
      continue;
    }
    suma += mxn / tc;
  }
  return { usd: sinTc > 0 ? null : round2(suma), sinTc };
}

/** Insumos del bloque (todo lo calcula el general ANTES). */
export interface InsumosBalanceEmpresa {
  participaciones: BalanceEmpresaParticipacionPayload[];
  movimientos: ReadonlyArray<MovimientoParaEmpresa>;
  /** Hoja «otros gastos» del general (`gastos_empresa`). */
  otrosGastos: { total_mxn: number; usd: number | null };
  /** T.C. promedio de la flota (`consolidado.totales.tc_promedio`). */
  tcPromedio: number | null;
  /** Hoja «inventario» (tienda); null/ausente = sin inventario. */
  inventario?: {
    total_utilidad_mxn?: number | null;
    total_utilidad_usd?: number | null;
  } | null;
}

/** Arma el bloque «VUELATOUR (empresa)» — fuente ÚNICA de su aritmética. */
export function armarBalanceEmpresa(
  e: InsumosBalanceEmpresa,
): BalanceEmpresaBloquePayload {
  const tc = pos(e.tcPromedio);

  // (+) Participación como socia: los montos del bloque de cada avión.
  const participacionUsd = e.participaciones.some((p) => p.monto_usd == null)
    ? null
    : round2(e.participaciones.reduce((a, p) => a + (p.monto_usd ?? 0), 0));

  // (+) Ingresos y (−) egresos propios de «otros movimientos».
  const ingresos = ladoEnUsd(e.movimientos, 'ingreso');
  const egresos = ladoEnUsd(e.movimientos, 'egreso');
  const movimientosSinTc = e.movimientos.filter(
    (m) =>
      ladoEnUsd([m], 'ingreso').sinTc > 0 || ladoEnUsd([m], 'egreso').sinTc > 0,
  ).length;

  // (−) Otros gastos: EXACTAMENTE el TOTAL USD de su hoja.
  const otrosUsd = e.otrosGastos.usd;

  // (+) Tienda: utilidad de la hoja «inventario» ÷ T.C. promedio.
  const utilidadTiendaMxn = num(e.inventario?.total_utilidad_mxn);
  let tiendaUsd: number | null = null;
  let tiendaSinTc = false;
  if (utilidadTiendaMxn != null) {
    if (utilidadTiendaMxn === 0) tiendaUsd = 0;
    else if (tc != null) tiendaUsd = round2(utilidadTiendaMxn / tc);
    else tiendaSinTc = true;
  }

  const resultado =
    participacionUsd != null &&
    ingresos.usd != null &&
    egresos.usd != null &&
    otrosUsd != null &&
    !tiendaSinTc
      ? round2(
          participacionUsd +
            ingresos.usd -
            egresos.usd -
            otrosUsd +
            (tiendaUsd ?? 0),
        )
      : null;

  return {
    participaciones: e.participaciones,
    participacion_usd: participacionUsd,
    ingresos_propios_usd: ingresos.usd,
    pagos_vendedor_usd: egresos.usd,
    otros_gastos_empresa_usd: otrosUsd,
    tc_usado: tc,
    tienda_utilidad_usd: tiendaUsd,
    resultado_usd: resultado,
    tc_promedio: tc,
    nota: notaBalanceEmpresa({
      participaciones: e.participaciones,
      participacionUsd,
      movimientosSinTc,
      otrosGastos: e.otrosGastos,
      tc,
      utilidadTiendaMxn,
      tiendaSinTc,
      utilidadTiendaUsdLegado: num(e.inventario?.total_utilidad_usd),
    }),
    movimientos_sin_tc: movimientosSinTc,
  };
}

/** Texto corto con la base de cada línea (lo que pyservices pone en nota). */
function notaBalanceEmpresa(n: {
  participaciones: BalanceEmpresaParticipacionPayload[];
  participacionUsd: number | null;
  movimientosSinTc: number;
  otrosGastos: { total_mxn: number; usd: number | null };
  tc: number | null;
  utilidadTiendaMxn: number | null;
  tiendaSinTc: boolean;
  utilidadTiendaUsdLegado: number | null;
}): string {
  const aviones = [...new Set(n.participaciones.map((p) => p.matricula))];
  const partes: string[] = [];
  partes.push(
    aviones.length > 0
      ? `Participación: utilidad COBRADA de ${aviones.join(', ')} × % de la empresa como socia${
          n.participacionUsd == null
            ? ' (algún avión sin utilidad cobrada: queda vacía)'
            : ''
        }.`
      : 'Participación: la empresa no es socia de ningún avión del periodo.',
  );
  partes.push(
    "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo y sueltas), " +
      'cada fila a USD con el T.C. de su vuelo; las sueltas con su T.C. o el oficial del día. ' +
      'Egresos = pago al vendedor, TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.',
  );
  if (n.movimientosSinTc > 0) {
    partes.push(
      `${n.movimientosSinTc} fila(s) de 'otros movimientos' sin T.C.: ingresos/egresos y resultado quedan vacíos hasta capturarlo.`,
    );
  }
  const tcTxt = n.tc != null ? n.tc.toFixed(2) : 'sin T.C.';
  partes.push(
    `Otros gastos: hoja 'otros gastos' ($${fmt(n.otrosGastos.total_mxn)} MXN ÷ T.C. promedio de la flota ${tcTxt})${
      n.otrosGastos.usd == null ? ' — sin USD: el resultado queda vacío' : ''
    }.`,
  );
  if (n.utilidadTiendaMxn == null) {
    partes.push('Tienda: sin inventario en el periodo.');
  } else {
    partes.push(
      `Tienda: utilidad de la hoja 'inventario' ($${fmt(n.utilidadTiendaMxn)} MXN) ÷ el mismo T.C.${
        n.tiendaSinTc ? ' — sin T.C.: el resultado queda vacío' : ''
      }.`,
    );
  }
  if (n.utilidadTiendaUsdLegado != null && n.utilidadTiendaUsdLegado !== 0) {
    partes.push(
      `No incluye $${fmt(n.utilidadTiendaUsdLegado)} USD de utilidad de salidas sin T.C. (legado).`,
    );
  }
  partes.push('Los gastos personales del dueño no entran.');
  return partes.join(' ');
}

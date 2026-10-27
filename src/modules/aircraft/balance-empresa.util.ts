import type {
  BalanceEmpresaBloquePayload,
  BalanceEmpresaExternoVueloPayload,
  BalanceEmpresaExternosPayload,
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
 *    vuelo + AFAC por vuelo (invariante 90) + sueltas), cada fila de
 *    regreso a USD con SU T.C. (el K del vuelo; una fila AFAC por vuelo,
 *    el T.C. promedio de costos del libro de su avión; una
 *    suelta, el T.C. que la convirtió o el oficial del día).
 *    BASE (revisión 6-oct-2026): el ingreso de esa hoja es lo COTIZADO de
 *    los vuelos del periodo no cancelados —COTIZADO y RESERVA incluidos—,
 *    no lo cobrado; el egreso, todo lo que la hoja resta (lo pagado; desde
 *    el 0.0.73-0.0.74 ya no hay provisión del vendedor, invariantes 58 y
 *    61). La parte de VuelaTour AÚN POR COBRAR viaja aparte e INFORMATIVA
 *    (`ingresos_por_cobrar_usd`): no se resta.
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
      /**
       * ADITIVO (18-oct-2026, API 0.0.94, invariante 92): utilidad COBRADA
       * EN PESOS × % (la del bloque del avión). Ausente = libro sin pesos.
       */
      monto_mxn?: number | null;
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
        // ADITIVO (18-oct-2026, API 0.0.94, invariante 92): la celda MONTO
        // MXN del socio-empresa en el bloque del avión, TAL CUAL. Solo si el
        // libro la trae (un libro sin pesos no agrega la llave).
        ...(s.monto_mxn !== undefined ? { monto_mxn: s.monto_mxn } : {}),
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
  /**
   * Parte de VuelaTour del vuelo de la fila AÚN POR COBRAR, en USD
   * (informativa; 0 en sueltas, cancelados y vuelos cobrados).
   */
  por_cobrar_usd?: number;
}

/**
 * Empareja las filas de «otros movimientos» con sus T.C. (mismo índice) y,
 * si viene, con la parte de VuelaTour por cobrar de cada fila. Distinto
 * número de filas y de T.C. (o de montos por cobrar) es un error de
 * programación que movería dinero entre filas: se LANZA (jamás se adivina
 * el emparejado).
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
  porCobrarUsd?: ReadonlyArray<number>,
): MovimientoParaEmpresa[] {
  if (filas.length !== tcs.length) {
    throw new Error(
      `Bloque VUELATOUR: «otros movimientos» (${hoja}) trae ${filas.length} fila(s) y ${tcs.length} T.C. — no se puede convertir a USD`,
    );
  }
  if (porCobrarUsd && porCobrarUsd.length !== filas.length) {
    throw new Error(
      `Bloque VUELATOUR: «otros movimientos» (${hoja}) trae ${filas.length} fila(s) y ${porCobrarUsd.length} monto(s) por cobrar`,
    );
  }
  return filas.map((f, i) => ({
    concepto_ingreso: f.concepto_ingreso,
    ingreso_mxn: f.ingreso_mxn,
    concepto_egreso: f.concepto_egreso,
    egreso_mxn: f.egreso_mxn,
    tc: tcs[i],
    ...(porCobrarUsd ? { por_cobrar_usd: porCobrarUsd[i] } : {}),
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

/**
 * BALANCE EN PESOS (18-oct-2026, API 0.0.94, invariante 92): un lado
 * (ingreso o egreso) de «otros movimientos» EN PESOS = Σ de la columna MXN
 * tal cual (la que la hoja YA pinta), redondeado al final. Una fila cuyo
 * concepto dice «sin TC» no llegó (o llegó a medias) a pesos ⇒ el lado
 * queda en `null` (mismo criterio que `ladoEnUsd`; aquí NO hace falta T.C.
 * para regresar a USD).
 */
export function ladoEnMxn(
  movimientos: ReadonlyArray<MovimientoParaEmpresa>,
  lado: 'ingreso' | 'egreso',
): number | null {
  let suma = 0;
  for (const m of movimientos) {
    const concepto =
      lado === 'ingreso' ? m.concepto_ingreso : m.concepto_egreso;
    if (concepto != null && MARCA_SIN_TC.test(concepto)) return null;
    const mxn = lado === 'ingreso' ? m.ingreso_mxn : m.egreso_mxn;
    if (mxn == null || mxn === 0) continue;
    suma += mxn;
  }
  return round2(suma);
}

/** Texto corto de la base EN PESOS del bloque (la `nota` explica el USD). */
export const NOTA_PESOS_BALANCE_EMPRESA =
  'En pesos: participación = utilidad COBRADA en pesos de cada avión × % de la empresa como socia; ' +
  "ingresos y egresos propios = la columna MXN de 'otros movimientos' tal cual; " +
  "otros gastos = TOTAL MXN de 'otros gastos'; tienda = utilidad MXN de 'inventario'. " +
  'Los dólares son informativos.';

/**
 * VUELOS CON AVIONES EXTERNOS (27-oct-2026, API 0.0.112, invariante 112).
 * Pedido del cliente (captura del bloque de septiembre): «me falta en el
 * balance de VuelaTour los vuelos con aviones externos … que sea claro
 * cuánto dejaron de ingreso, cuánto de gastos y al final la utilidad, y un
 * resumen a un lado de cuántos fueron». Lo que el bloque necesita del libro
 * EXTERNOS del general (vuelos de operador ajeno SIN avión de la flota),
 * YA calculado por ese libro con el MISMO row-loop que un avión: aquí no se
 * recalcula nada, solo se cita.
 */
export interface LibroExternosParaEmpresa {
  vuelos: ReadonlyArray<{
    clave: string;
    folio: string;
    fecha: string | null;
    cliente: string | null;
    operador_externo?: string | null;
    estado: string;
    cancelado?: boolean;
    /** Fila SOMBRA (invariante 89): horas de otro mes, sin dinero. */
    fila_sombra?: boolean;
    ruta: string;
    total_mxn: number | null;
    total_usd: number | null;
    ganancia_mxn: number | null;
    ganancia_usd: number | null;
    por_cobrar_mxn: number | null;
    status_cobro: string;
  }>;
  totales: {
    /** VENTA MXN del libro (fila TOTALES). */
    total_mxn: number;
    por_cobrar_mxn: number;
    por_cobrar_usd: number;
  };
  balance: {
    utilidad_antes_usd: number;
    utilidad_despues_usd: number | null;
    utilidad_antes_mxn?: number;
    utilidad_despues_mxn?: number | null;
  };
}

/** Operador ajeno legible (texto libre del vuelo); vacío ⇒ null. */
function textoOperador(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
}

/** round2(a − b); null si falta alguno (jamás una resta a medias). */
function resta(a: unknown, b: unknown): number | null {
  const x = num(a);
  const y = num(b);
  return x == null || y == null ? null : round2(x - y);
}

/** Σ de montos, redondeada al final; null si alguno es null. */
function sumaEstricta(valores: ReadonlyArray<number | null>): number | null {
  let suma = 0;
  for (const v of valores) {
    if (v == null) return null;
    suma += v;
  }
  return round2(suma);
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/**
 * Lo que dejaron los vuelos con aviones externos, del libro EXTERNOS que el
 * general YA calculó (`undefined` sin libro: el bloque de siempre, sin la
 * llave). EN PESOS: ingreso = la VENTA del libro (fila TOTALES), utilidad
 * = su UTILIDAD DESPUÉS DE GASTOS y gastos = lo que hay entre las dos (todo
 * lo que su cascada resta: operaciones con el pago al operador —una sola
 * vez, invariantes 88 y 110—, combustible, comisiones, permisos y otros).
 * La utilidad entra COMPLETA aunque esté por cobrar (como los ingresos
 * propios del bloque; lo pendiente se informa). Una fila sin pesos deja
 * ingreso, gastos y utilidad en `null` (el TOTAL del libro la suma como 0:
 * sería un ingreso que omite dinero) y la nota la nombra. Los dólares son
 * informativos: Σ VENTA USD de las filas y la cascada USD del libro.
 */
export function externosParaEmpresa(
  libro: LibroExternosParaEmpresa | null | undefined,
): BalanceEmpresaExternosPayload | undefined {
  if (!libro) return undefined;
  // Filas con dinero: una SOMBRA (invariante 89) es horas de otro mes.
  const filas = libro.vuelos.filter((v) => v.fila_sombra !== true);
  const detalle: BalanceEmpresaExternoVueloPayload[] = filas.map((v) => ({
    clave: v.clave,
    folio: v.folio,
    fecha: v.fecha,
    cliente: v.cliente,
    operador: textoOperador(v.operador_externo),
    estado: v.estado,
    cancelado: v.cancelado === true,
    ruta: v.ruta,
    ingreso_mxn: num(v.total_mxn),
    gastos_mxn: resta(v.total_mxn, v.ganancia_mxn),
    utilidad_mxn: num(v.ganancia_mxn),
    por_cobrar_mxn: round2(num(v.por_cobrar_mxn) ?? 0),
    status_cobro: v.status_cobro,
    ingreso_usd: num(v.total_usd),
    gastos_usd: resta(v.total_usd, v.ganancia_usd),
    utilidad_usd: num(v.ganancia_usd),
  }));
  const sinPesos = detalle
    .filter((d) => d.ingreso_mxn == null || d.utilidad_mxn == null)
    .map((d) => d.clave);
  const operadores = [
    ...new Set(
      detalle.map((d) => d.operador).filter((o): o is string => o != null),
    ),
  ];
  const antesMxn = num(libro.balance.utilidad_antes_mxn);
  const despuesMxn = num(libro.balance.utilidad_despues_mxn);
  const ingresoMxn =
    sinPesos.length > 0 ? null : round2(libro.totales.total_mxn);
  const utilidadMxn = sinPesos.length > 0 ? null : despuesMxn;
  const gastosMxn = resta(ingresoMxn, utilidadMxn);
  const hojasMxn = sinPesos.length > 0 ? null : resta(antesMxn, despuesMxn);
  const porCobrarMxn = round2(libro.totales.por_cobrar_mxn);
  const ingresoUsd = sumaEstricta(detalle.map((d) => d.ingreso_usd));
  const utilidadUsd = num(libro.balance.utilidad_despues_usd);
  const gastosUsd = resta(ingresoUsd, utilidadUsd);
  const hojasUsd = resta(libro.balance.utilidad_antes_usd, utilidadUsd);
  const porCobrarUsd = round2(libro.totales.por_cobrar_usd);
  const cancelados = detalle.filter((d) => d.cancelado).length;
  const vuelosPorCobrar = detalle.filter((d) => d.por_cobrar_mxn > 0).length;
  return {
    vuelos: detalle.length,
    cancelados,
    operadores,
    ingreso_mxn: ingresoMxn,
    gastos_mxn: gastosMxn,
    utilidad_mxn: utilidadMxn,
    por_cobrar_mxn: porCobrarMxn,
    hojas_mxn: hojasMxn,
    ingreso_usd: ingresoUsd,
    gastos_usd: gastosUsd,
    utilidad_usd: utilidadUsd,
    por_cobrar_usd: porCobrarUsd,
    hojas_usd: hojasUsd,
    detalle,
    sin_pesos: sinPesos,
    nota: notaExternos({
      vuelos: detalle.length,
      cancelados,
      operadores,
      porCobrarMxn,
      vuelosPorCobrar,
      sinPesos,
      utilidadMxn,
    }),
  };
}

/** Texto corto con la base de las líneas de vuelos externos (pie del bloque). */
function notaExternos(n: {
  vuelos: number;
  cancelados: number;
  operadores: string[];
  porCobrarMxn: number;
  vuelosPorCobrar: number;
  sinPesos: string[];
  utilidadMxn: number | null;
}): string {
  const partes: string[] = [];
  partes.push(
    `Vuelos con aviones externos (libro EXTERNOS del periodo): ${plural(n.vuelos, 'vuelo', 'vuelos')}${
      n.cancelados > 0
        ? ` (${plural(n.cancelados, 'cancelado', 'cancelados')})`
        : ''
    }${n.operadores.length > 0 ? ` con ${n.operadores.join(', ')}` : ''}.`,
  );
  partes.push(
    'Ingreso = la VENTA de cada vuelo en ese libro (lo cotizado al T.C. de su vuelo; en un cancelado, lo realmente cobrado); ' +
      'gastos = todo lo que ese libro resta (operaciones con el pago al operador —una sola vez—, combustible, comisiones, permisos y otros); ' +
      'utilidad = su UTILIDAD DESPUÉS DE GASTOS, que suma en el RESULTADO completa aunque esté por cobrar.',
  );
  if (n.porCobrarMxn > 0) {
    partes.push(
      `De esos vuelos, $${fmt(n.porCobrarMxn)} MXN siguen por cobrar (${plural(n.vuelosPorCobrar, 'vuelo', 'vuelos')}).`,
    );
  }
  partes.push(
    'Sus TUAs, extras, pernocta y comisión del vendedor ya están en los ingresos y egresos propios (no se suman dos veces).',
  );
  if (n.sinPesos.length > 0) {
    partes.push(
      `${n.sinPesos.join(', ')} sin pesos (sin T.C.): ingreso, gastos, utilidad y RESULTADO quedan vacíos hasta capturarlo.`,
    );
  } else if (n.utilidadMxn == null) {
    partes.push(
      'Una hoja del libro EXTERNOS no tiene pesos (combustible o permisos en USD sin T.C.): gastos, utilidad y RESULTADO quedan vacíos hasta capturarlo.',
    );
  }
  return partes.join(' ');
}

/** Insumos del bloque (todo lo calcula el general ANTES). */
export interface InsumosBalanceEmpresa {
  participaciones: BalanceEmpresaParticipacionPayload[];
  movimientos: ReadonlyArray<MovimientoParaEmpresa>;
  /**
   * Hoja «otros gastos» del general (`gastos_empresa`). `filas` (opcional)
   * solo decide si su TOTAL MXN es completo (una fila sin pesos ⇒ null).
   */
  otrosGastos: {
    total_mxn: number;
    usd: number | null;
    filas?: ReadonlyArray<{ monto_mxn: number | null }>;
  };
  /** T.C. promedio de la flota (`consolidado.totales.tc_promedio`). */
  tcPromedio: number | null;
  /** Hoja «inventario» (tienda); null/ausente = sin inventario. */
  inventario?: {
    total_utilidad_mxn?: number | null;
    total_utilidad_usd?: number | null;
  } | null;
  /**
   * ¿Algún avión absorbió un pago «Comisión del vendedor (avión)» de un
   * vuelo del periodo (13-oct-2026, API 0.0.74, invariante 61: vuelo
   * COMPLETADO o CANCELADO con cobros retenidos, en su columna COMISIONES)?
   * Solo cambia la NOTA: en esos vuelos la pestaña trae ese pago con egreso
   * $0.00 «a cargo del avión». La aritmética no cambia: `pagos_vendedor_usd`
   * = Σ egresos REALES de la pestaña («(VuelaTour)» + «(avión)» que nadie
   * carga); las filas de $0.00 no lo bajan ni anulan el lado (no llevan
   * «sin TC»): el pago ya restó en el avión, nunca dos veces. Ausente o
   * false ⇒ la nota corta.
   */
  pagoVendedorACargoDelAvion?: boolean;
  /**
   * ¿«otros movimientos» trae filas «AFAC por vuelo» (16-oct-2026, API
   * 0.0.89, invariante 90; SUSTITUYE a la señal de las filas «AFAC ·
   * matrícula» de la invariante 62, que se eliminó)? Solo cambia la NOTA
   * —mismo patrón que `pagoVendedorACargoDelAvion`—: la aritmética ya toma
   * las filas por `movimientos`, cada una ÷ su `tc` = `totales.tc_promedio`
   * del libro de su avión (ingreso = lo RESERVADO de cada vuelo; egreso = el
   * COSTO REAL capturado, que paga VuelaTour; los gastos marcados «Pago de
   * AFAC» no están en la pestaña). Ausente o false ⇒ la nota de siempre.
   */
  afacPorVuelo?: boolean;
  /**
   * VUELOS CON AVIONES EXTERNOS (27-oct-2026, API 0.0.112, invariante 112):
   * `externosParaEmpresa(libro EXTERNOS)`; ausente o null = el general no
   * tuvo libro EXTERNOS (bloque de siempre, sin la llave). Su `utilidad_*`
   * SUMA en el resultado; su null se propaga como el de cualquier línea.
   */
  externos?: BalanceEmpresaExternosPayload | null;
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
  // Parte de VuelaTour AÚN POR COBRAR (informativa: NO se resta — el
  // ingreso de la hoja es lo cotizado; la nota lo dice con su monto).
  const porCobrar = e.movimientos
    .map((m) => num(m.por_cobrar_usd) ?? 0)
    .filter((x) => x > 0);
  const ingresosPorCobrarUsd = round2(porCobrar.reduce((a, x) => a + x, 0));

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

  // (+) VUELOS CON AVIONES EXTERNOS (27-oct-2026, invariante 112): la
  // utilidad del libro EXTERNOS, tal cual; sin libro, 0 y sin llave.
  const ext = e.externos ?? null;
  const externosMxn = ext ? ext.utilidad_mxn : 0;
  const externosUsd = ext ? ext.utilidad_usd : 0;

  // ===== EN PESOS (18-oct-2026, API 0.0.94, invariante 92) =====
  // Mismas fuentes, en su columna MXN: ningún T.C. de por medio.
  const participacionMxn = e.participaciones.some((p) => p.monto_mxn == null)
    ? null
    : round2(e.participaciones.reduce((a, p) => a + (p.monto_mxn ?? 0), 0));
  const ingresosMxn = ladoEnMxn(e.movimientos, 'ingreso');
  const egresosMxn = ladoEnMxn(e.movimientos, 'egreso');
  const otrosMxn = (e.otrosGastos.filas ?? []).some((f) => f.monto_mxn == null)
    ? null
    : round2(e.otrosGastos.total_mxn);
  const resultadoMxn =
    participacionMxn != null &&
    ingresosMxn != null &&
    egresosMxn != null &&
    otrosMxn != null &&
    externosMxn != null
      ? round2(
          participacionMxn +
            ingresosMxn -
            egresosMxn -
            otrosMxn +
            (utilidadTiendaMxn ?? 0) +
            externosMxn,
        )
      : null;

  const resultado =
    participacionUsd != null &&
    ingresos.usd != null &&
    egresos.usd != null &&
    otrosUsd != null &&
    !tiendaSinTc &&
    externosUsd != null
      ? round2(
          participacionUsd +
            ingresos.usd -
            egresos.usd -
            otrosUsd +
            (tiendaUsd ?? 0) +
            externosUsd,
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
      ingresosUsd: ingresos.usd,
      ingresosPorCobrarUsd,
      vuelosPorCobrar: porCobrar.length,
      otrosGastos: e.otrosGastos,
      tc,
      utilidadTiendaMxn,
      tiendaSinTc,
      utilidadTiendaUsdLegado: num(e.inventario?.total_utilidad_usd),
      pagoVendedorACargoDelAvion: e.pagoVendedorACargoDelAvion === true,
      afacPorVuelo: e.afacPorVuelo === true,
    }),
    movimientos_sin_tc: movimientosSinTc,
    ingresos_por_cobrar_usd: ingresosPorCobrarUsd,
    vuelos_por_cobrar: porCobrar.length,
    // ADITIVAS (18-oct-2026, API 0.0.94, invariante 92): el bloque EN
    // PESOS. pyservices las pinta como la columna principal solo con
    // `balance_en_pesos`; `nota` sigue explicando el USD.
    participacion_mxn: participacionMxn,
    ingresos_propios_mxn: ingresosMxn,
    pagos_vendedor_mxn: egresosMxn,
    otros_gastos_empresa_mxn: otrosMxn,
    tienda_utilidad_mxn: utilidadTiendaMxn,
    resultado_mxn: resultadoMxn,
    nota_pesos: NOTA_PESOS_BALANCE_EMPRESA,
    // VUELOS CON AVIONES EXTERNOS (27-oct-2026, API 0.0.112, invariante
    // 112; ADITIVA, ÚLTIMA llave): solo con libro EXTERNOS. Su utilidad ya
    // sumó arriba en los dos resultados.
    ...(ext ? { externos: ext } : {}),
  };
}

/** Texto corto con la base de cada línea (lo que pyservices pone en nota). */
function notaBalanceEmpresa(n: {
  participaciones: BalanceEmpresaParticipacionPayload[];
  participacionUsd: number | null;
  movimientosSinTc: number;
  ingresosUsd: number | null;
  ingresosPorCobrarUsd: number;
  vuelosPorCobrar: number;
  otrosGastos: { total_mxn: number; usd: number | null };
  tc: number | null;
  utilidadTiendaMxn: number | null;
  tiendaSinTc: boolean;
  utilidadTiendaUsdLegado: number | null;
  pagoVendedorACargoDelAvion: boolean;
  afacPorVuelo: boolean;
}): string {
  const aviones = [...new Set(n.participaciones.map((p) => p.matricula))];
  // Revisión 6-oct-2026: la nota NOMBRA el avión que vacía la participación
  // (antes decía «algún avión» y la oficina no sabía dónde buscar).
  const sinUtilidad = [
    ...new Set(
      n.participaciones
        .filter((p) => p.monto_usd == null)
        .map((p) => p.matricula),
    ),
  ];
  const partes: string[] = [];
  partes.push(
    aviones.length > 0
      ? `Participación: utilidad COBRADA de ${aviones.join(', ')} × % de la empresa como socia${
          n.participacionUsd == null && sinUtilidad.length > 0
            ? ` (${sinUtilidad.join(', ')} sin utilidad cobrada —revisa los pendientes de su libro—: queda vacía)`
            : ''
        }.`
      : 'Participación: la empresa no es socia de ningún avión del periodo.',
  );
  // Revisión 12-oct-2026 (API 0.0.73, invariante 58): «otros movimientos» ya
  // NO provisiona el pago al vendedor (sin gasto real la fila no lleva
  // egreso). Desde el 13-oct-2026 (API 0.0.74, invariante 61) el pago real
  // se captura en DOS categorías: la «Comisión del vendedor (VuelaTour)»
  // egresa aquí y la «Comisión del vendedor (avión)» que carga un avión en
  // su columna COMISIONES aquí egresa $0.00 — con esos vuelos la nota lo
  // dice; sin ellos, el texto corto.
  const pagoVendedor = n.pagoVendedorACargoDelAvion
    ? 'pago al vendedor (solo los gastos reales capturados: la «Comisión del vendedor (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en su columna COMISIONES aquí egresa $0.00)'
    : 'pago al vendedor (solo los gastos reales de comisión del vendedor capturados)';
  // AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90; sustituye la
  // nota de las filas «AFAC · matrícula» de la invariante 62): el ingreso
  // incluye lo RESERVADO de cada vuelo (que su avión ya carga como costo) y
  // el egreso el COSTO REAL capturado por vuelo (lo paga VuelaTour); los
  // gastos marcados «Pago de AFAC» no egresan aquí (son el comprobante). Sin
  // filas AFAC, el texto de siempre byte a byte. `pagoVendedor` va TAL CUAL.
  partes.push(
    n.afacPorVuelo
      ? "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo, AFAC por vuelo y sueltas), " +
          'cada fila a USD con el T.C. de su vuelo; las filas AFAC con el T.C. promedio de costos del libro de su avión (sin vuelos, el oficial del cierre); ' +
          'las sueltas con su T.C. o el oficial del día. ' +
          'Ingresos = lo COTIZADO (TUAs, extras, pernocta y comisión del vendedor) de los vuelos del periodo no cancelados, ' +
          'COTIZADO y RESERVA incluidos, más el AFAC RESERVADO de cada vuelo (lo que su avión ya carga como costo en su columna PERMISO AFAC). ' +
          `Egresos = ${pagoVendedor}, TUAs pagadas, extensión de horario, comisión bancaria, gastos sueltos y el COSTO REAL AFAC capturado por vuelo (lo paga VuelaTour); ` +
          'los gastos marcados «Pago de AFAC» no egresan aquí: son el comprobante de esos costos.'
      : "Ingresos y egresos propios: hoja 'otros movimientos' (por vuelo y sueltas), " +
          'cada fila a USD con el T.C. de su vuelo; las sueltas con su T.C. o el oficial del día. ' +
          'Ingresos = lo COTIZADO (TUAs, extras, pernocta y comisión del vendedor) de los vuelos del periodo no cancelados, ' +
          'COTIZADO y RESERVA incluidos. ' +
          `Egresos = ${pagoVendedor}, TUAs pagadas, extensión de horario, comisión bancaria y gastos sueltos.`,
  );
  if (n.ingresosUsd != null && n.ingresosPorCobrarUsd > 0) {
    partes.push(
      `De esos ingresos, $${fmt(n.ingresosPorCobrarUsd)} USD de ${n.vuelosPorCobrar} vuelo(s) aún están por cobrar.`,
    );
  }
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
      `Tienda: utilidad de la hoja 'inventario' ($${fmt(n.utilidadTiendaMxn)} MXN) ÷ el mismo T.C. promedio${
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

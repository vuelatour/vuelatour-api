import type {
  BalanceAvionPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';

/**
 * PERMISOS AFAC COMO FILAS QUE SUMAN en la pestaña «otros movimientos» del
 * Balance general (13-oct-2026, API 0.0.74, invariante 62). Decisión 2 del
 * lote del cliente del 13-oct-2026: «AFAC en "otros movimientos" del Balance
 * general: filas en la tabla principal que suman en TOTALES (provisión AFAC
 * del periodo = ingreso de VuelaTour por avión; cada permiso pagado =
 * egreso), ya no bloque informativo bajo totales».
 *
 * SUPERSEDE el punto (2) de la invariante 53 (12-oct-2026, API 0.0.69): el
 * bloque INFORMATIVO `afac` debajo de TOTALES ya no se arma. Ahora va UNA
 * fila «AFAC · matrícula» por avión REAL (orden de `librosAviones` = el de
 * los bloques de la hoja «balance»; el libro EXTERNOS nunca llega aquí):
 *  - INGRESO = la provisión AFAC del periodo de ese avión, TAL CUAL la trae
 *    su libro (`totales.permiso_afac_mxn` = Σ de su columna T «PERMISO AFAC
 *    (PROVISIÓN)», round2(tarifa × z × D) por vuelo). Nadie la recalcula.
 *  - EGRESO INFORMATIVO = $0.00 (revisión del 13-oct-2026, antes del
 *    deploy): las filas de su hoja «permisos» (TODOS los gastos PERMISO del
 *    avión del periodo, con o sin vuelo —no solo los de AFAC—: exactamente
 *    `filasPermisos` de `buildPayload`) se LISTAN en el concepto y la nota
 *    con su monto, «· a cargo del avión XB-PEV ($5,518.00 en su hoja
 *    «permisos»)», pero NO egresan aquí: ya restan en el avión (hoja
 *    «permisos» → `permisos_usd` de su cascada → utilidad cobrada → socios,
 *    y el grupo PERMISO del reparto). Egresarlos también aquí los contaba
 *    DOS veces en el grupo (y VuelaTour pagaba 1 + su % como socia). Mismo
 *    patrón que la «Comisión del vendedor (avión)» de la invariante 61.
 *  - Apareados en la MISMA fila (como las TUAS), remanente = ingreso (la
 *    provisión; 0 si solo hay permisos).
 *
 * POR QUÉ DENTRO DE `filas` (y no en una lista aparte): así un pyservices
 * previo las pinta y las SUMA como filas normales (TOTALES y bloque
 * VUELATOUR cuadran también en la ventana de skew). El API nunca manda filas
 * AFAC y el bloque `afac` a la vez: un pyservices viejo pintaría las filas
 * sumadas Y la leyenda «NO entran a los TOTALES», que sería falsa.
 *
 * UN GASTO, UNA VEZ, UN MES: todo se deriva de los libros YA calculados
 * (cero consultas). La provisión sigue el eje `fecha_vuelo` (día Cancún) de
 * la hoja de vuelos; el permiso pagado, la regla del libro (`gastosAvion`
 * por `fecha_gasto` y `gastosVueloDelAvion` en el MES DEL VUELO aunque
 * `fecha_gasto` sea otro; parciales de reparto con su parte). Cada permiso
 * cae en el mismo libro/mes que su hoja «permisos» y nunca en dos. Un
 * PERMISO sin avión ni vuelo no entra aquí (sigue en «otros gastos»); uno
 * de un vuelo EXTERNO se queda en el libro EXTERNOS. Reconstruir estas filas
 * con una consulta propia a `gasto` rompería esa identidad.
 *
 * USD Y MXN NUNCA SE SUMAN: el monto que cita el concepto son pesos ya
 * convertidos por el libro; un permiso sin `monto_mxn` (USD sin T.C.) se
 * cuenta aparte («1 en USD sin T.C.»). Como el egreso es $0.00, el concepto
 * NUNCA lleva la marca «sin TC» (palabra completa, la que
 * `balance-empresa.util#ladoEnUsd` usa para vaciar ese lado del bloque
 * VUELATOUR): el permiso no egresa aquí, así que no le falta nada a ese
 * lado (el avión, sin T.C., deja su propia utilidad vacía).
 *
 * T.C. de la fila (bloque VUELATOUR, invariante 47; NO viaja a pyservices):
 * `totales.tc_promedio` del libro de su avión —promedio de las z de costos
 * redondeado a 2 con vuelos; sin vuelos, el oficial del cierre que el libro
 * ya escribió ahí— y null se propaga. DRIFT DOCUMENTADO: la provisión en
 * USD (Σ X_i ÷ promedio de z) difiere de tarifa × Σ horas cuando z varía
 * dentro del mes (el egreso es $0.00: no tiene drift). Si el cliente exige
 * USD exacto, el refinamiento es aditivo (T.C. ponderado solo para el
 * ingreso). Si algún día el permiso egresa aquí (ver abajo), su USD
 * diferiría de `permisos.usd` del libro por centavos (`tc_promedio` va
 * redondeado a 2; `tcHojas`, crudo): `tc_egreso` en `MovimientoParaEmpresa`.
 *
 * UN PERMISO PAGADO, UNA VEZ (revisión del 13-oct-2026; pregunta ABIERTA al
 * cliente en «Pendientes conocidos» del CLAUDE.md): la decisión 2 decía
 * «cada permiso pagado = egreso», pero el permiso PAGADO ya resta en el avión
 * (hoja «permisos» → `permisos_usd` de la cascada → utilidad cobrada →
 * socios, y en el reparto el grupo PERMISO) desde antes del 0.0.74 y el
 * reparto de septiembre ya se entregó así. Mientras el cliente no diga si
 * sale del avión, el egreso aquí es $0.00 INFORMATIVO: el grupo lo resta UNA
 * vez (en el avión) y los socios no cambian. Si responde «sale del avión»,
 * el cambio va JUNTO, en un solo deploy: `utilidadDespues` sin
 * `hojaPermisos.usd`, el grupo PERMISO fuera del saldo del reparto, y aquí
 * `egreso_mxn` = Σ `monto_mxn` (con la marca «sin TC» de siempre). La
 * provisión NO es doble (sale del avión en su columna T y entra a VuelaTour
 * aquí).
 *
 * PROHIBIDO en cualquier texto generado aquí: la secuencia «· PROVISIÓN (»
 * (marca `_MARCA_PROVISION` del amarillo de pyservices). Por eso «provisión»
 * va siempre en minúsculas y sin punto medio delante.
 */

/** Lo que la fila necesita de UN libro de avión. */
export type LibroParaAfac = Pick<
  BalanceAvionPayload,
  | 'matricula'
  | 'avion_color'
  | 'permiso_afac_usd_hr'
  | 'vuelos'
  | 'totales'
  | 'permisos'
>;

/**
 * Filas AFAC (una por avión con provisión o permisos pagados) y el T.C. con
 * que cada una regresa a USD en el bloque VUELATOUR, alineados por índice.
 */
export interface FilasAfacOtrosMovimientos {
  filas: BalanceOtroMovimientoFilaPayload[];
  tcs: Array<number | null>;
}

/** Mismo redondeo que el resto del balance. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

/** Número positivo o null (copia del de `balance-empresa.util`). */
function pos(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Monto con 2 decimales es-MX (mismo formato que `fmtMontoOM`). */
function fmt(n: number): string {
  return r2(n).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 'YYYY-MM-DD…' ⇒ 'DD/MM/YYYY' por corte de texto (sin `Date` ni zona: la
 * fecha del gasto ya es un día). Otro texto, tal cual; vacío ⇒ null.
 */
function fechaCorta(iso: string | null | undefined): string | null {
  if (iso == null) return null;
  const t = String(iso).trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : t;
}

/**
 * Fuente ÚNICA y PURA de las filas «AFAC · matrícula» de «otros
 * movimientos»: suma lo que los libros YA traen (cero consultas, cero
 * recálculo de provisiones o de T.C.). Un libro sin provisión ni permisos
 * pagados no genera fila (avión sin tarifa ni PERMISO ⇒ nada).
 */
export function filasAfacOtrosMovimientos(
  libros: ReadonlyArray<LibroParaAfac>,
): FilasAfacOtrosMovimientos {
  const filas: BalanceOtroMovimientoFilaPayload[] = [];
  const tcs: Array<number | null> = [];
  for (const p of libros) {
    const provision = r2(Number(p.totales?.permiso_afac_mxn) || 0);
    const vuelosAfac = p.vuelos.filter(
      (v) => (Number(v.permiso_afac_mxn) || 0) !== 0,
    );
    const permisos = p.permisos?.filas ?? [];
    const hayIngreso = provision !== 0 || vuelosAfac.length > 0;
    const hayEgreso = permisos.length > 0;
    if (!hayIngreso && !hayEgreso) continue;
    const tarifa = pos(p.permiso_afac_usd_hr);
    const tarifaTxt = tarifa != null ? fmt(tarifa) : null;

    // ===== Lado INGRESO: la provisión AFAC del periodo de este avión.
    let conceptoIngreso: string | null = null;
    let ingresoMxn: number | null = null;
    let notaIngreso: string | null = null;
    if (hayIngreso) {
      const n = vuelosAfac.length;
      conceptoIngreso =
        `provisión AFAC del periodo · ${n} ${n === 1 ? 'vuelo' : 'vuelos'}` +
        (tarifaTxt != null ? ` · tarifa ${tarifaTxt} USD/hr` : '');
      ingresoMxn = provision;
      notaIngreso = [
        `Provisión AFAC de cada vuelo de ${p.matricula} (columna PERMISO AFAC de su hoja de vuelos)` +
          (tarifaTxt != null
            ? `: tarifa ${tarifaTxt} USD/hr × T.C. de costos × horas cobradas`
            : ''),
        ...vuelosAfac.map(
          (v) => `${v.clave} = $${fmt(Number(v.permiso_afac_mxn) || 0)}`,
        ),
      ].join('\n');
    }

    // ===== Lado EGRESO: los permisos pagados (hoja «permisos» del libro),
    // INFORMATIVOS con $0.00: ya restan en el avión (ver la cabecera).
    let conceptoEgreso: string | null = null;
    let egresoMxn: number | null = null;
    let fechaEgreso: string | null = null;
    let notaEgreso: string | null = null;
    if (hayEgreso) {
      const conMonto = permisos.filter((f) => f.monto_mxn != null);
      const sinMonto = permisos.length - conMonto.length;
      const pagadoMxn =
        conMonto.length > 0
          ? r2(conMonto.reduce((acc, f) => acc + (f.monto_mxn ?? 0), 0))
          : null;
      // UN GASTO, UNA VEZ: el permiso ya restó en la cascada del avión.
      egresoMxn = 0;
      // «$5,518.00 en su hoja «permisos»» (+ «; 1 en USD sin T.C.»). Jamás
      // la marca «sin TC» (la fila egresa $0.00: a ese lado no le falta
      // nada) ni un USD sumado como pesos.
      const cifra =
        pagadoMxn != null
          ? `$${fmt(pagadoMxn)} en su hoja «permisos»` +
            (sinMonto > 0 ? `; ${sinMonto} en USD sin T.C.` : '')
          : 'en USD sin T.C. en su hoja «permisos»';
      const aCargo = ` · a cargo del avión ${p.matricula} (${cifra})`;
      conceptoEgreso =
        permisos.length === 1
          ? `permiso AFAC pagado · ${permisos[0].detalle}${aCargo}`
          : `permisos AFAC pagados · ${permisos.length} conceptos (ver nota)${aCargo}`;
      // La fecha NO nula más antigua (misma regla que `colapsarFilasDeVuelo`).
      fechaEgreso =
        permisos
          .map((f) => f.fecha)
          .filter((f): f is string => Boolean(f))
          .sort()[0] ?? null;
      if (permisos.length > 1) {
        notaEgreso = permisos
          .map((f) => {
            const fecha = fechaCorta(f.fecha);
            return (
              `permiso AFAC pagado · ${f.detalle} = ` +
              (f.monto_mxn != null ? `$${fmt(f.monto_mxn)}` : '—') +
              (fecha ? ` · ${fecha}` : '')
            );
          })
          .join('\n');
      }
    }

    filas.push({
      clave: `AFAC · ${p.matricula}`,
      avion_color: p.avion_color ?? null,
      fecha_vuelo: null,
      concepto_egreso: conceptoEgreso,
      egreso_mxn: egresoMxn,
      fecha_egreso: fechaEgreso,
      concepto_ingreso: conceptoIngreso,
      ingreso_mxn: ingresoMxn,
      fecha_ingreso: null,
      // Como `colapsarFilasDeVuelo`: un lado sin monto cuenta 0. Con permisos
      // el egreso es SIEMPRE 0 (informativo), así que el remanente es la
      // provisión (0 si solo hay permisos: la fila informativa no mueve
      // TOTALES, como la de la «Comisión del vendedor (avión)»).
      remanente_mxn:
        ingresoMxn == null && egresoMxn == null
          ? null
          : r2((ingresoMxn ?? 0) - (egresoMxn ?? 0)),
      factura: null,
      ...(notaIngreso ? { nota_ingreso: notaIngreso } : {}),
      ...(notaEgreso ? { nota_egreso: notaEgreso } : {}),
      seccion: 'AFAC',
    });
    // T.C. de regreso a USD (bloque VUELATOUR): el promedio de costos del
    // libro de este avión (sin vuelos, el oficial del cierre). null se
    // propaga: la fila cuenta en `movimientos_sin_tc`.
    tcs.push(pos(p.totales?.tc_promedio));
  }
  return { filas, tcs };
}

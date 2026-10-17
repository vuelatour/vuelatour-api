import type {
  BalanceAfacPagoPayload,
  BalanceAfacResumenPayload,
  BalanceAfacVueloPayload,
  BalanceAvionPayload,
  BalanceOtroMovimientoFilaPayload,
} from '../pyservices/pyservices.service';
import {
  CONCEPTO_AFAC_REAL_POR_CAPTURAR,
  MENSAJE_AFAC_VUELO_SIN_AVION,
  MOTIVO_AFAC_NO_HABILITADO,
  avisoDiferenciaPagado,
  avisoPagosSinTc,
  avisoRealesFueraDeLibro,
  avisoVuelosSinReal,
  conceptoAfacReal,
  conceptoAfacReservado,
  motivoFilaNoDuena,
  notaAfacReservado,
  r2,
} from '../../common/afac-real.util';
import type {
  AfacRealDelPeriodo,
  AfacRealLeido,
} from '../../common/afac-real.lector';
import {
  textoMesCerrado,
  type CierreParaTexto,
} from '../../common/mes-contable.util';

/**
 * AFAC POR VUELO en «otros movimientos» del Balance general (16-oct-2026,
 * API 0.0.89, invariante 90). SUPERSEDE la fila «AFAC · matrícula» por avión
 * de la invariante 62 (`afac-otros-movimientos.util`, eliminado).
 *
 * Fuente única PURA (cero consultas, cero recálculo): una fila por FILA DE
 * LIBRO (no sombra) con AFAC RESERVADO (≠ 0) o con COSTO REAL capturado:
 *  - INGRESO (columna G) = lo RESERVADO = `fila.permiso_afac_mxn` TAL CUAL
 *    (la columna PERMISO AFAC (PROVISIÓN) de la hoja de vuelos de su avión,
 *    round2(tarifa × z × horas cobradas); nadie la recalcula). El avión lo
 *    sigue pagando: es costo en su cascada.
 *  - EGRESO (columna D, la celda EDITABLE del libro en pantalla) = el COSTO
 *    REAL que VuelaTour pagó a AFAC por ese vuelo (`afac_vuelo`); vacío
 *    (null, cuenta 0) mientras no se capture.
 *  - REMANENTE = reservado − real: lo que VuelaTour gana o pierde por vuelo.
 * Grupo (aviones + VuelaTour): −reservado (avión) + reservado − real
 * (VuelaTour) = −real, UNA vez. Los gastos marcados «Pago de AFAC» NO
 * egresan aquí ni en ningún avión: son el comprobante y van en el resumen
 * (`pagos`) para la comparación del mes.
 *
 * Van DENTRO de `otros_movimientos.filas` (al final, contiguas): un
 * pyservices viejo las pinta y SUMA como filas normales — TOTALES y bloque
 * VUELATOUR cuadran también en la ventana de skew. Sin reales ni marcas,
 * Σ ingreso por avión = `totales.permiso_afac_mxn` de su libro (lo que el
 * 0.0.88 ponía en su fila «AFAC · matrícula») y el bloque VUELATOUR sale
 * igual (± 0.01 de punto flotante).
 *
 * FILA SOMBRA (vuelo diferido a otro mes, invariante 89): fuera (su dinero y
 * su real viven en el mes destino). FILA QUE VIENE: dentro. Multi-avión: una
 * fila por libro (cada una con SU reservado); el real se pinta UNA vez, en
 * la primera fila del vuelo en el orden final (la «dueña»).
 */

/** Matrícula del libro de los vuelos externos sin avión de la flota. */
export const MATRICULA_LIBRO_EXTERNOS = 'EXTERNOS';

/** Lo que la sección necesita de UN libro (aviones y EXTERNOS). */
export type LibroParaAfacVuelo = Pick<
  BalanceAvionPayload,
  'matricula' | 'avion_color' | 'vuelos' | 'totales'
>;

export interface EntradaAfacPorVuelo {
  /** TODOS los libros construidos del general, en su orden. */
  libros: ReadonlyArray<LibroParaAfacVuelo>;
  /** Costos reales capturados por `vuelo_id` (lector; vacío sin migración). */
  reales: ReadonlyMap<string, AfacRealLeido>;
  /** Mes contable 'YYYY-MM' por `vuelo_id` (si falta: el de `fila.fecha`). */
  mesPorVuelo: ReadonlyMap<string, string | null>;
  /** Meses CERRADOS ('YYYY-MM' ⇒ cierre, para el motivo). */
  mesesCerrados: ReadonlyMap<string, CierreParaTexto>;
  /** ¿Migración 20261016000005 aplicada? (`afacRealDisponible`). */
  disponible: boolean;
  /** Pagos marcados «Pago de AFAC» del periodo (libros + sueltos). */
  pagos: ReadonlyArray<BalanceAfacPagoPayload>;
  /** Red de seguridad: reales cuyo vuelo cuenta en el periodo. */
  realesDelPeriodo: ReadonlyArray<AfacRealDelPeriodo>;
}

export interface SalidaAfacPorVuelo {
  filas: BalanceOtroMovimientoFilaPayload[];
  /** T.C. de regreso a USD de cada fila (bloque VUELATOUR), por índice. */
  tcs: Array<number | null>;
  resumen: BalanceAfacResumenPayload | null;
  pendientes: string[];
}

/** Número finito o null. */
function num(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Número positivo o null (T.C.). */
function pos(v: unknown): number | null {
  const x = num(v);
  return x != null && x > 0 ? x : null;
}

interface Candidata {
  libro: LibroParaAfacVuelo;
  fila: BalanceAvionPayload['vuelos'][number];
  reservado: number | null;
  ordenLibro: number;
  ordenFila: number;
}

/** Orden cronológico entre aviones (como el consolidado de la flota). */
function comparar(a: Candidata, b: Candidata): number {
  const ka = String(a.fila.orden_ts ?? a.fila.fecha ?? '');
  const kb = String(b.fila.orden_ts ?? b.fila.fecha ?? '');
  if (ka !== kb) return ka.localeCompare(kb);
  const fa = Number(a.fila.folio) || 0;
  const fb = Number(b.fila.folio) || 0;
  if (fa !== fb) return fa - fb;
  const ma = a.libro.matricula.localeCompare(b.libro.matricula);
  if (ma !== 0) return ma;
  return a.ordenLibro - b.ordenLibro || a.ordenFila - b.ordenFila;
}

/**
 * Filas «AFAC por vuelo», su T.C., el resumen del periodo y los avisos.
 * Sin filas, sin pagos y sin reales fuera de libro ⇒ todo vacío y
 * `resumen: null` (la pestaña sale byte a byte sin llaves nuevas).
 */
export function filasAfacPorVuelo(e: EntradaAfacPorVuelo): SalidaAfacPorVuelo {
  const candidatas: Candidata[] = [];
  e.libros.forEach((libro, ordenLibro) => {
    libro.vuelos.forEach((fila, ordenFila) => {
      if (fila.fila_sombra === true) return;
      const reservadoRaw = num(fila.permiso_afac_mxn);
      const reservado =
        reservadoRaw != null && reservadoRaw !== 0 ? reservadoRaw : null;
      const real = fila.vuelo_id ? e.reales.get(fila.vuelo_id) : undefined;
      if (reservado == null && !real) return;
      candidatas.push({ libro, fila, reservado, ordenLibro, ordenFila });
    });
  });
  candidatas.sort(comparar);

  const filas: BalanceOtroMovimientoFilaPayload[] = [];
  const tcs: Array<number | null> = [];
  /** vuelo_id ⇒ matrícula de su fila DUEÑA (la primera en el orden). */
  const duena = new Map<string, string>();
  const vuelosConFila = new Set<string>();
  const vuelosConReservado = new Set<string>();
  const vuelosConReal = new Set<string>();
  /** vuelo_id ⇒ Σ reservado (> 0) de TODAS sus filas (multi-avión). */
  const reservadoPorVuelo = new Map<string, number>();
  let reservadoTotal = 0;
  let realTotal = 0;

  for (const c of candidatas) {
    const { libro, fila, reservado } = c;
    const vueloId = fila.vuelo_id ?? '';
    const sinId = vueloId === '';
    const esDuena = !sinId && !duena.has(vueloId);
    if (esDuena) duena.set(vueloId, libro.matricula);
    const realLeido =
      esDuena && vueloId ? (e.reales.get(vueloId) ?? null) : null;
    const real = realLeido ? r2(realLeido.costo_real_mxn) : null;
    const horas = num(fila.horas_cobradas);
    const tarifa = pos(fila.permiso_afac_usd_hr);
    const tc = pos(fila.tc_costos);
    const mes =
      (vueloId ? e.mesPorVuelo.get(vueloId) : undefined) ??
      (typeof fila.fecha === 'string' && fila.fecha
        ? fila.fecha.slice(0, 7)
        : null);
    const cierre = mes ? (e.mesesCerrados.get(mes) ?? null) : null;
    const esAvion = libro.matricula !== MATRICULA_LIBRO_EXTERNOS;

    let motivo: string | null = null;
    if (!e.disponible) motivo = MOTIVO_AFAC_NO_HABILITADO;
    else if (!sinId && !esDuena)
      motivo = motivoFilaNoDuena(duena.get(vueloId) ?? libro.matricula);
    else if (!esAvion || sinId) motivo = MENSAJE_AFAC_VUELO_SIN_AVION;
    else if (cierre) motivo = textoMesCerrado(cierre);

    const remanente =
      reservado == null && real == null
        ? null
        : r2((reservado ?? 0) - (real ?? 0));
    const conceptoEgreso =
      real != null
        ? conceptoAfacReal(
            realLeido?.capturado_por_nombre ?? null,
            realLeido?.capturado_at ?? null,
          )
        : esDuena || sinId
          ? CONCEPTO_AFAC_REAL_POR_CAPTURAR
          : `AFAC costo real · en su fila de ${duena.get(vueloId) ?? libro.matricula}`;
    const notaIngreso =
      reservado != null
        ? notaAfacReservado({
            reservado,
            horas,
            tarifa,
            tc,
            cierreMarca: fila.cierre_marca ?? null,
          })
        : null;
    const notaEgreso = realLeido?.notas ?? null;
    const afac: BalanceAfacVueloPayload = {
      vuelo_id: vueloId,
      matricula: libro.matricula,
      horas_cobradas: horas,
      tarifa_usd_hr: tarifa,
      tc_costos: tc,
      reservado_mxn: reservado,
      costo_real_mxn: real,
      remanente_mxn: remanente,
      capturado_por_nombre:
        real != null ? (realLeido?.capturado_por_nombre ?? null) : null,
      capturado_at: real != null ? (realLeido?.capturado_at ?? null) : null,
      notas: real != null ? (realLeido?.notas ?? null) : null,
      mes_contable: mes,
      editable: motivo == null,
      motivo_no_editable: motivo,
      cierre_marca: fila.cierre_marca ?? null,
    };
    filas.push({
      clave: fila.clave,
      avion_color: libro.avion_color ?? null,
      estado: fila.estado,
      fecha_vuelo: fila.fecha,
      concepto_egreso: conceptoEgreso,
      egreso_mxn: real,
      fecha_egreso: null,
      concepto_ingreso:
        reservado != null
          ? conceptoAfacReservado({
              matricula: libro.matricula,
              horas,
              tarifa,
              tc,
            })
          : null,
      ingreso_mxn: reservado,
      fecha_ingreso: null,
      remanente_mxn: remanente,
      factura: null,
      ...(notaIngreso ? { nota_ingreso: notaIngreso } : {}),
      ...(notaEgreso ? { nota_egreso: notaEgreso } : {}),
      ...(fila.clave_cliente ? { clave_cliente: fila.clave_cliente } : {}),
      seccion: 'AFAC_VUELO',
      afac,
    });
    // T.C. de regreso a USD (bloque VUELATOUR, invariante 47): el promedio
    // de costos del libro de su avión — el MISMO de la fila por avión del
    // 0.0.88 (sin reales, el bloque sale igual). null se propaga.
    tcs.push(pos(libro.totales?.tc_promedio));

    if (vueloId) vuelosConFila.add(vueloId);
    if (reservado != null) {
      reservadoTotal += reservado;
      if (vueloId) vuelosConReservado.add(vueloId);
    }
    if (real != null) {
      realTotal += real;
      vuelosConReal.add(vueloId);
    }
    if (vueloId && reservado != null && reservado > 0) {
      reservadoPorVuelo.set(
        vueloId,
        (reservadoPorVuelo.get(vueloId) ?? 0) + reservado,
      );
    }
  }
  // Vuelos con AFAC reservado y SIN costo real (solo con la migración: sin
  // ella no hay dónde capturarlo y el aviso sería ruido).
  const sinReal = new Map<string, number>(
    e.disponible
      ? [...reservadoPorVuelo].filter(([vid]) => !vuelosConReal.has(vid))
      : [],
  );

  // Red de seguridad: reales que no cayeron en ninguna fila.
  const fuera = e.realesDelPeriodo.filter(
    (r) => !vuelosConFila.has(r.vuelo_id),
  );
  const fueraMxn = r2(fuera.reduce((a, r) => a + r.costo_real_mxn, 0));

  const pagos = [...e.pagos].sort((a, b) =>
    String(a.fecha ?? '').localeCompare(String(b.fecha ?? '')),
  );
  const pagosConPesos = pagos.filter((p) => p.monto_mxn != null);
  const pagado = r2(pagosConPesos.reduce((a, p) => a + (p.monto_mxn ?? 0), 0));
  const pagosSinTc = pagos.length - pagosConPesos.length;

  if (filas.length === 0 && pagos.length === 0 && fuera.length === 0) {
    return { filas, tcs, resumen: null, pendientes: [] };
  }
  const reservadoMxn = r2(reservadoTotal);
  const realMxn = r2(realTotal);
  const diferencia = r2(pagado - realMxn);
  const resumen: BalanceAfacResumenPayload = {
    vuelos: vuelosConFila.size,
    vuelos_con_reservado: vuelosConReservado.size,
    vuelos_con_real: vuelosConReal.size,
    vuelos_sin_real: sinReal.size,
    reservado_mxn: reservadoMxn,
    costo_real_mxn: realMxn,
    remanente_mxn: r2(reservadoMxn - realMxn),
    pagado_mxn: pagado,
    pagos_sin_tc: pagosSinTc,
    diferencia_pagado_mxn: diferencia,
    reales_fuera_de_libro_mxn: fueraMxn,
    pagos,
  };
  const pendientes: string[] = [];
  if (sinReal.size > 0) {
    pendientes.push(
      avisoVuelosSinReal(
        sinReal.size,
        r2([...sinReal.values()].reduce((a, x) => a + x, 0)),
      ),
    );
  }
  if (Math.abs(diferencia) >= 0.01) {
    pendientes.push(
      avisoDiferenciaPagado({
        pagadoMxn: pagado,
        pagos: pagosConPesos.length,
        realMxn,
        diferenciaMxn: diferencia,
      }),
    );
  }
  if (pagosSinTc > 0) pendientes.push(avisoPagosSinTc(pagosSinTc));
  if (fuera.length > 0) {
    pendientes.push(
      avisoRealesFueraDeLibro(
        fueraMxn,
        fuera.map((r) => r.folio),
      ),
    );
  }
  return { filas, tcs, resumen, pendientes };
}

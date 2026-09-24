/**
 * EXCEL DE LA REPOSICIÓN de caja chica (24-sep-2026). Palabras del cliente:
 * «en el apartado de caja chica, quiero ver si se puede al momento de
 * reembolsar la caja de cada uno, me puede arrojar un Excel descargable con
 * la información de lo que estoy reembolsando».
 *
 * PURO (sin Nest ni Supabase): arma el payload de
 * `POST /reportes/caja-chica-reposicion.xlsx` de pyservices (hoja con
 * encabezado legible, tabla, fila TOTAL, totales y avisos) y, como RESPALDO
 * mientras ese endpoint no esté desplegado, el del export genérico
 * `/pdf/tabla-xlsx` (`tablaXlsxDeCaja`, el mismo mecanismo de
 * `inventory.itemsXlsx`) — así el orden de deploy API/pyservices no importa.
 *
 * EL DINERO NO SE CALCULA AQUÍ: qué entradas entran, en qué orden y con qué
 * saldo lo decide `tramoDeReposicion` sobre `historialConSaldo`
 * (`common/caja-chica-saldo.util.ts`, fuente única). Aquí solo se formatea.
 */
import {
  CONCEPTO_CAJA,
  type EntradaTramoLike,
  type TramoReposicion,
} from '../../common/caja-chica-saldo.util';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { etiquetaComprobante } from '../../common/comprobante.util';
import { etiquetaFacturacion } from '../../common/facturacion-gasto.util';
import { fechaHoraCancun } from '../../common/fecha-cancun.util';
import type {
  CajaChicaDatoPayload,
  CajaChicaFilaPayload,
  CajaChicaReposicionPayload,
  TablaColumnaPayload,
  TablaXlsxPayload,
} from '../pyservices/pyservices.service';

/** Entrada del libro tal como la arma `CajaChicaService.cargarLibro`. */
export interface EntradaLibroXlsx extends EntradaTramoLike {
  notas: string | null;
  referencia: string | null;
  categoria: string | null;
  lugar: string | null;
  vuelo_folio: number | null;
  registrado_por_nombre: string | null;
  autorizado_por_nombre: string | null;
}

/** Datos de PRESENTACIÓN de cada gasto (consulta aparte, por id). */
export interface ExtraGastoXlsx {
  estatus_comprobante: string | null;
  estatus_facturacion: string | null;
  matricula: string | null;
  capturo: string | null;
  /** Momento de captura (sello de la app) o, si no hay, `created_at`. */
  capturado_en: string | null;
  /** Llegada al servidor: decide si el gasto se capturó DESPUÉS de reponer. */
  created_at: string | null;
}

export interface FondoXlsx {
  responsable: string;
  moneda: string;
  es_acumulada: boolean;
  monto_fondo: number | null;
  /** Nombre del dueño de la caja MADRE (caja vinculada) o null. */
  caja_madre: string | null;
}

export type ModoExcelCaja = 'reposicion' | 'pendiente';

/** Color del resalte: gasto capturado DESPUÉS de registrar la reposición. */
export const COLOR_CAPTURADO_DESPUES = 'ED7D31';

/**
 * Columnas de la tabla — MISMO orden y textos que `COLUMNAS` de
 * `vuelatour-pyservices/app/services/caja_chica_xlsx.py` (paridad manual; el
 * respaldo genérico las usa tal cual).
 */
export const COLUMNAS_EXCEL_CAJA: TablaColumnaPayload[] = [
  { label: 'Fecha' },
  { label: 'Tipo' },
  { label: 'Categoría' },
  { label: 'Descripción / lugar' },
  { label: 'Vuelo' },
  { label: 'Matrícula' },
  { label: 'Gasto', tipo: 'money' },
  { label: 'Reintegro / ajuste (±)', tipo: 'money' },
  { label: 'Comprobante' },
  { label: 'Facturación' },
  { label: 'Capturó' },
  { label: 'Capturado (hora Cancún)' },
  { label: 'Saldo del libro', tipo: 'money' },
  { label: 'Por reponer', tipo: 'money' },
];
const COL_FECHA = 0;
const COL_CAPTURADO = 11;

/** 'YYYY-MM-DD' → 'dd/mm/aaaa' (fecha de pared, sin zona). */
export function fechaDmy(dia: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** «$1,234.50» (es-MX, dos decimales) para textos del encabezado. */
export function montoTexto(n: number): string {
  const abs = Math.abs(n).toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? '−' : ''}$${abs}`;
}

function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Primera línea de las notas (el resto suele ser el sello de captura). */
function primeraLinea(t: string | null | undefined): string {
  return (t ?? '').split('\n')[0].trim();
}

/** Texto ASCII seguro para nombre de archivo (sin acentos ni símbolos). */
export function asciiArchivo(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nombre del archivo: «Reposicion caja <responsable> <YYYY-MM-DD>.xlsx» o,
 * para lo pendiente, «Por reponer caja <responsable> <hoy>.xlsx». ASCII (el
 * `filename=` del Content-Disposition no admite acentos de forma portable).
 */
export function nombreArchivoCaja(
  modo: ModoExcelCaja,
  responsable: string,
  fecha: string,
): string {
  const quien = asciiArchivo(responsable) || 'sin nombre';
  const prefijo =
    modo === 'reposicion' ? 'Reposicion caja' : 'Por reponer caja';
  return `${prefijo} ${quien} ${fecha}.xlsx`;
}

/** Content-Disposition `attachment` con el nombre (ASCII + RFC 5987). */
export function dispositionXlsx(filename: string): string {
  const ascii = asciiArchivo(filename.replace(/\.xlsx$/i, '')) + '.xlsx';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(ascii)}`;
}

function tipoCaja(f: FondoXlsx): string {
  if (f.es_acumulada) return 'Acumulada (se repone lo gastado)';
  return f.monto_fondo && f.monto_fondo > 0
    ? 'Fondo fijo (se rellena hasta el monto del fondo)'
    : 'Fondo sin monto fijo';
}

export function leyendaDiferencia(d: number): string {
  if (d > 0) return 'Se repuso de más';
  if (d < 0) return 'Quedó pendiente por reponer';
  return 'Cuadra exacto';
}

export interface ArmarExcelCajaInput<T extends EntradaLibroXlsx> {
  modo: ModoExcelCaja;
  fondo: FondoXlsx;
  tramo: TramoReposicion<T>;
  extras: Map<string, ExtraGastoXlsx>;
  /** Día Cancún de hoy (YYYY-MM-DD) — corte del modo pendiente. */
  hoy: string;
  /** Instante de generación (texto «generado …»). */
  ahora: Date;
}

/**
 * Payload de `/reportes/caja-chica-reposicion.xlsx` + nombre de archivo.
 * ENCABEZADO (datos de la reposición), FILAS del periodo en el orden del
 * libro con el saldo y lo por reponer que ya trae el historial, fila TOTAL,
 * TOTALES (Σ, reintegros/ajustes, repuesto, diferencia, saldo antes y
 * después) y AVISOS (gastos capturados después de reponer).
 */
export function armarExcelCaja<T extends EntradaLibroXlsx>(
  input: ArmarExcelCajaInput<T>,
): { payload: CajaChicaReposicionPayload; filename: string } {
  const { modo, fondo, tramo, extras, hoy, ahora } = input;
  const repo = modo === 'reposicion' ? tramo.reposicion : null;
  const creadaRepo = repo ? Date.parse(repo.created_at) : NaN;
  let capturadosDespues = 0;

  const filas: CajaChicaFilaPayload[] = tramo.entradas.map((e) => {
    if (e.origen === 'gasto') {
      const x = extras.get(e.id);
      const creado = Date.parse(x?.created_at ?? e.created_at);
      const despues =
        Number.isFinite(creadaRepo) &&
        Number.isFinite(creado) &&
        creado > creadaRepo;
      if (despues) capturadosDespues += 1;
      return {
        fecha: e.fecha,
        tipo: CONCEPTO_CAJA.GASTO,
        categoria: etiquetaCategoriaGasto(e.categoria),
        descripcion: [primeraLinea(e.notas), (e.lugar ?? '').trim()]
          .filter(Boolean)
          .join(' · '),
        vuelo: e.vuelo_folio != null ? `#${e.vuelo_folio}` : '',
        matricula: x?.matricula ?? '',
        gasto: -e.monto,
        otro: null,
        comprobante: etiquetaComprobante(x?.estatus_comprobante),
        facturacion: etiquetaFacturacion(x?.estatus_facturacion),
        capturo: x?.capturo ?? e.registrado_por_nombre ?? '',
        capturado: fechaHoraCancun(
          x?.capturado_en ?? x?.created_at ?? e.created_at,
        ),
        saldo: e.saldo,
        por_reponer: e.por_reponer,
        resaltar: despues,
      };
    }
    // Movimiento de caja: la REFERENCIA primero («Fondeo a Luis Caceres»
    // del espejo de una caja vinculada) y luego la nota, sin repetir.
    const textos = [(e.referencia ?? '').trim(), primeraLinea(e.notas)].filter(
      Boolean,
    );
    return {
      fecha: e.fecha,
      tipo: CONCEPTO_CAJA[e.tipo] ?? e.tipo,
      categoria: '',
      descripcion: [...new Set(textos)].join(' · '),
      vuelo: '',
      matricula: '',
      gasto: null,
      otro: e.monto,
      comprobante: '',
      facturacion: '',
      capturo: e.registrado_por_nombre ?? '',
      capturado: fechaHoraCancun(e.created_at),
      saldo: e.saldo,
      por_reponer: e.por_reponer,
      resaltar: false,
    };
  });

  const nGastos = tramo.gastos.length;
  const periodo =
    tramo.periodo_desde && tramo.periodo_hasta
      ? `del ${fechaDmy(tramo.periodo_desde)} al ${fechaDmy(tramo.periodo_hasta)}`
      : null;
  const anteriorTxt = tramo.anterior
    ? `${fechaDmy(tramo.anterior.fecha)} · ${montoTexto(tramo.anterior.monto)}`
    : null;
  const otrosDato: CajaChicaDatoPayload[] =
    tramo.otros.length > 0
      ? [
          {
            etiqueta: 'Reintegros / ajustes del periodo',
            valor: tramo.total_otros,
            nota: plural(tramo.otros.length, 'movimiento', 'movimientos'),
          },
        ]
      : [];
  // LO QUE VENÍA DE ANTES (revisión 24-sep-2026, con libros REALES de prod):
  // sin estas dos líneas el Excel no cuadraba a la vista. Mary Cruz: «Σ
  // gastos pendientes $2,738.99» pero «POR REPONER HOY $29,812.92» — la
  // diferencia eran $22,347.93 que su reposición del 11-sep dejó pendientes
  // (+ fondeos a Luis). Alexander 21-sep: Σ gastos $3,658 contra repuesto
  // $3,656 «Cuadra exacto», porque la reposición anterior se había pasado
  // $2 (saldo al abrir $4,002 en un fondo de $4,000). Se LEEN de la fila de
  // la reposición anterior en el historial (`saldo_inicio` /
  // `por_reponer_inicio` de `tramoDeReposicion`): cero cálculo aquí.
  const veniaDeAntes: CajaChicaDatoPayload[] = tramo.anterior
    ? [
        {
          etiqueta: 'Saldo del libro al abrir el periodo',
          valor: tramo.saldo_inicio,
          nota: `Tras la reposición del ${fechaDmy(tramo.anterior.fecha)}`,
        },
        {
          etiqueta: 'Por reponer que venía de antes',
          valor: tramo.por_reponer_inicio,
          ...(tramo.por_reponer_inicio > 0
            ? { nota: 'Quedó pendiente de la reposición anterior' }
            : {}),
        },
      ]
    : [];

  const encabezado: CajaChicaDatoPayload[] = [
    { etiqueta: 'Responsable', valor: fondo.responsable },
    { etiqueta: 'Caja', valor: tipoCaja(fondo) },
    { etiqueta: 'Moneda', valor: fondo.moneda },
    {
      etiqueta: 'Monto del fondo',
      valor:
        fondo.monto_fondo && fondo.monto_fondo > 0
          ? fondo.monto_fondo
          : 'Sin monto fijo',
    },
    ...(fondo.caja_madre
      ? [{ etiqueta: 'Se fondea desde', valor: `Caja de ${fondo.caja_madre}` }]
      : []),
  ];
  const generado = `generado ${fechaHoraCancun(ahora)} (hora Cancún)`;
  let payload: CajaChicaReposicionPayload;

  if (repo) {
    const notas = [repo.notas, repo.referencia]
      .map((t) => (t ?? '').trim())
      .filter(Boolean);
    encabezado.push(
      { etiqueta: 'Fecha de la reposición', valor: fechaDmy(repo.fecha) },
      { etiqueta: 'Monto repuesto', valor: tramo.monto_repuesto },
      { etiqueta: 'Autorizó', valor: repo.autorizado_por_nombre ?? '—' },
      { etiqueta: 'Registró', valor: repo.registrado_por_nombre ?? '—' },
      {
        etiqueta: 'Notas / referencia',
        valor: [...new Set(notas)].join(' · ') || '—',
      },
      {
        etiqueta: 'Periodo cubierto',
        valor: periodo ?? 'Sin gastos entre la reposición anterior y esta',
      },
      {
        etiqueta: 'Reposición anterior',
        valor: anteriorTxt ?? 'Ninguna (es la primera reposición del fondo)',
      },
    );
    const diferencia = tramo.diferencia ?? 0;
    const totales: CajaChicaDatoPayload[] = [
      {
        etiqueta: 'Gastos del periodo',
        valor: plural(nGastos, 'gasto', 'gastos'),
      },
      ...veniaDeAntes,
      { etiqueta: 'Σ gastos del periodo', valor: tramo.total_gastos },
      ...otrosDato,
      {
        etiqueta: 'Por reponer antes de esta reposición',
        valor: tramo.por_reponer_antes,
      },
      { etiqueta: 'Monto repuesto', valor: tramo.monto_repuesto },
      {
        etiqueta: 'Diferencia (repuesto − por reponer)',
        valor: tramo.diferencia,
        nota: leyendaDiferencia(diferencia),
        destacado: true,
      },
      { etiqueta: 'Saldo del libro antes', valor: tramo.saldo_antes },
      { etiqueta: 'Saldo del libro después', valor: tramo.saldo_despues },
      { etiqueta: 'Por reponer después', valor: tramo.por_reponer_despues },
    ];
    if (!tramo.anterior && !fondo.es_acumulada) {
      totales.push({
        etiqueta: 'Nota',
        valor:
          'Primera reposición del fondo: la diferencia incluye la entrega inicial del fondo.',
      });
    }
    payload = {
      titulo: `Reposición de caja chica · ${fondo.responsable}`,
      subtitulo: `Reposición del ${fechaDmy(repo.fecha)} por ${montoTexto(repo.monto)} ${fondo.moneda} · ${generado}`,
      hoja: `Reposición ${fechaDmy(repo.fecha).replace(/\//g, '-')}`,
      encabezado_titulo: 'Datos de la reposición',
      encabezado,
      filas,
      n_gastos: nGastos,
      total_gastos: tramo.total_gastos,
      total_otros: tramo.otros.length > 0 ? tramo.total_otros : null,
      totales_titulo: 'Totales de la reposición',
      totales,
      avisos:
        capturadosDespues > 0
          ? [
              `${plural(capturadosDespues, 'gasto se capturó', 'gastos se capturaron')} DESPUÉS de registrar esta reposición (resaltados en naranja): no estaban en la cuenta cuando se repuso.`,
            ]
          : [],
      sin_filas: 'Sin gastos entre la reposición anterior y esta.',
    };
  } else {
    encabezado.push(
      { etiqueta: 'Corte al', valor: fechaDmy(hoy) },
      {
        etiqueta: 'Última reposición',
        valor: anteriorTxt ?? 'Ninguna todavía',
      },
      {
        etiqueta: 'Periodo pendiente',
        valor: periodo ?? 'Sin gastos pendientes desde la última reposición',
      },
    );
    payload = {
      titulo: `Por reponer · caja chica · ${fondo.responsable}`,
      subtitulo: `Pendiente de reponer al ${fechaDmy(hoy)} · ${generado}`,
      hoja: 'Por reponer',
      encabezado_titulo: 'Lo pendiente',
      encabezado,
      filas,
      n_gastos: nGastos,
      total_gastos: tramo.total_gastos,
      total_otros: tramo.otros.length > 0 ? tramo.total_otros : null,
      totales_titulo: 'Totales',
      totales: [
        {
          etiqueta: 'Gastos pendientes',
          valor: plural(nGastos, 'gasto', 'gastos'),
        },
        ...veniaDeAntes,
        { etiqueta: 'Σ gastos pendientes', valor: tramo.total_gastos },
        ...otrosDato,
        { etiqueta: 'Saldo del libro hoy', valor: tramo.saldo_antes },
        {
          etiqueta: 'POR REPONER HOY',
          valor: tramo.por_reponer_antes,
          destacado: true,
        },
      ],
      avisos: [],
      sin_filas: 'Sin gastos pendientes desde la última reposición.',
    };
  }

  const filename = nombreArchivoCaja(
    modo,
    fondo.responsable,
    repo ? repo.fecha : hoy,
  );
  return { payload, filename };
}

/**
 * RESPALDO: el mismo contenido en el export GENÉRICO `/pdf/tabla-xlsx` (ya
 * desplegado), para cuando pyservices todavía no tiene
 * `/reportes/caja-chica-reposicion.xlsx`. Encabezado + totales + avisos van
 * en el bloque «resumen»; los resaltes, por índice de fila.
 */
export function tablaXlsxDeCaja(
  p: CajaChicaReposicionPayload,
): TablaXlsxPayload {
  const par = (d: CajaChicaDatoPayload): (string | number | null)[] =>
    d.nota
      ? [d.etiqueta, d.valor ?? null, d.nota]
      : [d.etiqueta, d.valor ?? null];
  const resaltes: { fila: number; col: number; color?: string }[] = [];
  p.filas.forEach((f, i) => {
    if (!f.resaltar) return;
    for (const col of [COL_FECHA, COL_CAPTURADO]) {
      resaltes.push({ fila: i, col, color: COLOR_CAPTURADO_DESPUES });
    }
  });
  return {
    titulo: p.titulo,
    subtitulo: p.subtitulo,
    resumen_titulo: p.encabezado_titulo,
    resumen: [
      ...p.encabezado.map(par),
      ...p.totales.map(par),
      ...p.avisos.map((a) => ['Aviso', a]),
    ],
    columnas: COLUMNAS_EXCEL_CAJA,
    filas: p.filas.map((f) => [
      fechaDmy(f.fecha),
      f.tipo,
      f.categoria,
      f.descripcion,
      f.vuelo,
      f.matricula,
      f.gasto,
      f.otro,
      f.comprobante,
      f.facturacion,
      f.capturo,
      f.capturado,
      f.saldo,
      f.por_reponer,
    ]),
    totales: [
      'TOTAL',
      plural(p.n_gastos, 'gasto', 'gastos'),
      null,
      null,
      null,
      null,
      p.total_gastos,
      p.total_otros,
      null,
      null,
      null,
      null,
      null,
      null,
    ],
    ...(resaltes.length > 0 ? { resaltes } : {}),
  };
}

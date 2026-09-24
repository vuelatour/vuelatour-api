/**
 * Excel del registro de FACTURAS EMITIDAS (24-sep-2026) — payload PURO para
 * el export genérico de pyservices (`/pdf/tabla-xlsx`). Todo llega ya
 * calculado; aquí solo se acomoda. Mismos filtros que la lista (sin
 * paginar), orden por número.
 *
 * Reglas: las CANCELADAS aparecen con su monto pero el total dice que solo
 * suma VIGENTES; jamás se suma USD con MXN (con dos monedas el total queda
 * vacío y el resumen trae los totales por moneda).
 */
import type { TablaXlsxPayload } from '../pyservices/pyservices.service';
import { diaCancun, fechaHoraCancun } from '../../common/fecha-cancun.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import type {
  AlertaFactura,
  FacturaEmitida,
  ResumenFacturas,
} from './facturas-emitidas.types';
import type { FiltrosFacturas } from './facturas-emitidas.util';

export const COLUMNAS_EXCEL_FACTURAS: TablaXlsxPayload['columnas'] = [
  { label: 'Serie-Folio', tipo: 'texto' },
  { label: 'Emisor', tipo: 'texto' },
  { label: 'Serie', tipo: 'texto' },
  { label: 'Folio', tipo: 'texto' },
  { label: 'Número', tipo: 'entero' },
  { label: 'Folio fiscal (UUID)', tipo: 'texto' },
  { label: 'Fecha emisión', tipo: 'texto' },
  { label: 'Estatus', tipo: 'texto' },
  { label: 'Parcial', tipo: 'texto' },
  { label: 'Cliente (receptor)', tipo: 'texto' },
  { label: 'RFC receptor', tipo: 'texto' },
  { label: 'Vuelos', tipo: 'texto' },
  { label: 'Fecha(s) de vuelo', tipo: 'texto' },
  { label: 'Subtotal', tipo: 'money' },
  { label: 'IVA', tipo: 'money' },
  { label: 'Total', tipo: 'money' },
  { label: 'Moneda', tipo: 'texto' },
  { label: 'Método', tipo: 'texto' },
  { label: 'Forma de pago', tipo: 'texto' },
  { label: 'Cobro del vuelo', tipo: 'texto' },
  { label: 'PDF', tipo: 'texto' },
  { label: 'XML', tipo: 'texto' },
  { label: 'Alertas', tipo: 'texto' },
  { label: 'Registró', tipo: 'texto' },
  { label: 'Registrada el', tipo: 'texto' },
  { label: 'Motivo de cancelación', tipo: 'texto' },
];

const COL_SUBTOTAL = 13;
const COL_IVA = 14;
const COL_TOTAL = 15;

export const ETIQUETAS_ALERTA_EXCEL: Record<AlertaFactura, string> = {
  DUPLICADO_VUELO: 'Vuelo con 2 facturas',
  SIN_PDF: 'Sin PDF',
  SIN_VUELO: 'Sin vuelo',
  VUELO_CANCELADO: 'Vuelo cancelado',
};

/** 'YYYY-MM-DD' ⇒ 'dd/mm/aaaa' ('' si no es una fecha). */
export function ddmmaaaa(dia: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dia ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Instante ⇒ 'dd/mm/aaaa HH:mm' en hora Cancún ('' si no es válido). */
function fechaHoraDdmm(iso: string | null | undefined): string {
  const t = fechaHoraCancun(iso ?? null);
  if (!t) return '';
  const [dia, hora] = t.split(' ');
  return `${ddmmaaaa(dia)} ${hora ?? ''}`.trim();
}

function diaVuelo(iso: string | null): string {
  if (!iso) return '';
  try {
    return ddmmaaaa(diaCancun(iso));
  } catch {
    return '';
  }
}

/** Una fila del Excel por factura (mismo orden de columnas). */
export function filaExcelFactura(
  f: FacturaEmitida,
): (string | number | null)[] {
  return [
    f.etiqueta,
    f.emisora?.razon_social ?? f.emisor_nombre ?? '—',
    f.serie ?? '',
    f.folio,
    f.folio_num,
    f.uuid ?? '',
    ddmmaaaa(f.fecha_emision),
    f.estatus === 'CANCELADA' ? 'Cancelada' : 'Vigente',
    f.es_parcial ? 'Sí' : 'No',
    f.receptor_nombre ?? f.cliente?.nombre ?? '',
    f.receptor_rfc ?? '',
    f.vuelos.map((v) => `#${v.folio}`).join(', '),
    f.vuelos
      .map((v) => diaVuelo(v.fecha_vuelo))
      .filter(Boolean)
      .join(', '),
    f.subtotal,
    f.iva,
    f.total,
    f.moneda,
    f.metodo_pago ?? '',
    f.forma_pago ?? '',
    f.vuelos.map((v) => `#${v.folio}: ${v.cobro.semaforo.label}`).join(', '),
    f.pdf ? 'Sí' : 'No',
    f.xml ? 'Sí' : 'No',
    f.alertas.map((a) => ETIQUETAS_ALERTA_EXCEL[a]).join(', '),
    f.created_por_nombre ?? '',
    fechaHoraDdmm(f.created_at),
    f.cancelada?.motivo ?? '',
  ];
}

/** «Emitidas del 01/09/2026 al 30/09/2026 · Cliente: Maqar · Solo vigentes». */
export function textoFiltrosExcel(
  f: FiltrosFacturas,
  nombres: { cliente?: string | null; emisora?: string | null } = {},
): string {
  const partes: string[] = [];
  if (f.desde && f.hasta) {
    partes.push(`Emitidas del ${ddmmaaaa(f.desde)} al ${ddmmaaaa(f.hasta)}`);
  } else if (f.desde) {
    partes.push(`Emitidas desde el ${ddmmaaaa(f.desde)}`);
  } else if (f.hasta) {
    partes.push(`Emitidas hasta el ${ddmmaaaa(f.hasta)}`);
  }
  if (f.cliente_id) partes.push(`Cliente: ${nombres.cliente ?? 'elegido'}`);
  if (f.emisora_id) {
    partes.push(
      f.emisora_id === 'SIN_EMISORA'
        ? 'Sin emisor identificado'
        : `Emisor: ${nombres.emisora ?? 'elegido'}`,
    );
  }
  if (f.serie) {
    partes.push(
      f.serie === 'SIN_SERIE' ? 'Sin serie' : `Serie ${f.serie.toUpperCase()}`,
    );
  }
  if (f.estatus) {
    partes.push(f.estatus === 'VIGENTE' ? 'Solo vigentes' : 'Solo canceladas');
  }
  if (f.alerta) {
    const etiqueta: Record<string, string> = {
      duplicado_vuelo: 'Vuelo con 2 facturas',
      sin_pdf: 'Sin PDF',
      sin_vuelo: 'Sin vuelo',
      vuelo_cancelado: 'Vuelo cancelado',
    };
    partes.push(`Alerta: ${etiqueta[f.alerta] ?? f.alerta}`);
  }
  if (f.vuelo_id) partes.push('De un vuelo');
  if (f.q) partes.push(`Búsqueda: «${f.q}»`);
  return partes.join(' · ');
}

/** Payload COMPLETO del Excel (el servicio solo lo manda a pyservices). */
export function payloadExcelFacturas(p: {
  facturas: ReadonlyArray<FacturaEmitida>;
  resumen: ResumenFacturas;
  filtros: FiltrosFacturas;
  nombres?: { cliente?: string | null; emisora?: string | null };
  ahora?: Date;
}): TablaXlsxPayload {
  const filtros = textoFiltrosExcel(p.filtros, p.nombres);
  const generado = fechaHoraDdmm((p.ahora ?? new Date()).toISOString());
  const r = p.resumen;
  const resumen: (string | number | null)[][] = [
    ['Facturas en este Excel', p.facturas.length],
    ['Registradas (todo el registro)', r.registradas],
    ['Vigentes', r.vigentes],
    ['Canceladas', r.canceladas],
    ['Sin PDF', r.sin_pdf],
    ['Sin vuelo', r.sin_vuelo],
    ['Vuelos con 2+ facturas', r.vuelos_con_varias],
    ['En vuelo cancelado', r.en_vuelo_cancelado],
    ['Por facturar (pedidas sin factura)', r.por_facturar],
    ...r.totales_vigentes.map((t) => [
      `Total vigentes ${t.moneda}`,
      fmtDineroTexto(t.total, t.moneda),
    ]),
    ...r.huecos.map((h) => [
      `Faltan en la serie ${h.etiqueta_serie}`,
      `${h.faltantes.join(', ')}${h.truncado ? ` (y ${h.total_faltantes - h.faltantes.length} más)` : ''}`,
    ]),
  ];

  const vigentes = p.facturas.filter((f) => f.estatus === 'VIGENTE');
  const monedas = new Set(vigentes.map((f) => f.moneda));
  let totales: (string | number | null)[] | undefined;
  if (vigentes.length > 0) {
    totales = COLUMNAS_EXCEL_FACTURAS.map(() => null);
    if (monedas.size === 1) {
      const suma = (k: 'subtotal' | 'iva' | 'total') =>
        Math.round(
          vigentes.reduce((acc, f) => acc + (Number(f[k]) || 0), 0) * 100,
        ) / 100;
      totales[0] = `Total vigentes (${[...monedas][0]}; no suma canceladas)`;
      totales[COL_SUBTOTAL] = suma('subtotal');
      totales[COL_IVA] = suma('iva');
      totales[COL_TOTAL] = suma('total');
    } else {
      totales[0] =
        'Total vigentes: ver el resumen (MXN y USD no se suman entre sí)';
    }
  }

  return {
    titulo: 'Facturas emitidas',
    subtitulo: [filtros, `Generado ${generado}`].filter(Boolean).join(' · '),
    columnas: COLUMNAS_EXCEL_FACTURAS,
    filas: p.facturas.map(filaExcelFactura),
    ...(totales ? { totales } : {}),
    resumen_titulo: 'Resumen',
    resumen,
  };
}

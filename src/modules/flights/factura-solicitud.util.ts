/**
 * «NECESITO FACTURA» — SOLICITUD DE FACTURA POR VUELO (24-sep-2026), LÓGICA
 * PURA con spec.
 *
 * Pedido de Itzi (audio): «que haya algo que yo marque así como de necesito
 * factura … y a Mari le salga una alertita de que ese vuelo tiene que ser
 * primero facturado para que el cliente pague … que le salga como el
 * pendiente de factura. Porque no en todos los vuelos hacemos facturas».
 *
 * «POR FACTURAR» ES DERIVADO — nunca se guarda (`esPorFacturar`, definición
 * ÚNICA del contrato §3.8): solicitada AND vuelo no CANCELADO AND sin CFDI
 * del PAC (`facturado`) AND sin factura emitida VIGENTE ligada. El estatus
 * MANUAL «Facturado» NO saca al vuelo de la lista (la lista pide la factura
 * REGISTRADA con su PDF; el panel lo señala con `estatus_manual`).
 */
import { fechaCortaCancun } from '../../common/fecha-cancun.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import type {
  FacturaEmitidaMini,
  FacturaServicioBloque,
  FacturaServicioResumen,
  SolicitudFactura,
} from '../facturas-emitidas/facturas-emitidas.types';

/** Columnas de la solicitud en `vuelo` (migración 20260924000003). */
export const COLS_SOLICITUD_FACTURA =
  'factura_solicitada_at, factura_solicitada_por, factura_solicitud_nota, factura_paga_contra_factura';

/** Tope de la nota (mismo que el CHECK `vuelo_factura_solicitud_nota_chk`). */
export const LIMITE_NOTA_SOLICITUD = 500;

export interface VueloSolicitudRow {
  id?: string;
  estado?: string | null;
  facturado?: boolean | null;
  factura_solicitada_at?: string | null;
  factura_solicitada_por?: string | null;
  factura_solicitud_nota?: string | null;
  factura_paga_contra_factura?: boolean | null;
}

/** Factura emitida ligada (vía el puente), lo mínimo para el bloque. */
export interface FacturaLigadaRow {
  id: string;
  serie: string | null;
  folio: string;
  folio_num: unknown;
  uuid: string | null;
  fecha_emision: string;
  estatus: string;
  total: unknown;
  moneda: string;
  metodo_pago: string | null;
  pdf_path: string | null;
  xml_path: string | null;
  deleted_at?: string | null;
}

/** Columnas de la factura embebida en el puente para el bloque/resumen. */
export const COLS_FACTURA_LIGADA =
  'id, serie, folio, folio_num, uuid, fecha_emision, estatus, total, moneda, metodo_pago, pdf_path, xml_path, deleted_at';

/**
 * DEFINICIÓN ÚNICA de «por facturar» (§3.8): solicitada AND no CANCELADO AND
 * `facturado` (CFDI del PAC) ≠ true AND 0 facturas emitidas VIGENTES
 * (no borradas) ligadas.
 */
export function esPorFacturar(
  v: VueloSolicitudRow | null | undefined,
  vigentesLigadas: number,
): boolean {
  if (!v) return false;
  return (
    v.factura_solicitada_at != null &&
    v.factura_solicitada_at !== '' &&
    v.estado !== 'CANCELADO' &&
    v.facturado !== true &&
    vigentesLigadas === 0
  );
}

/** La solicitud del vuelo (o null si nadie la pidió). */
export function solicitudDe(
  v: VueloSolicitudRow | null | undefined,
  nombreSolicitante?: string | null,
): SolicitudFactura | null {
  if (!v?.factura_solicitada_at) return null;
  return {
    solicitada_at: v.factura_solicitada_at,
    solicitada_por: v.factura_solicitada_por
      ? { id: v.factura_solicitada_por, nombre: nombreSolicitante ?? null }
      : null,
    nota: v.factura_solicitud_nota ?? null,
    paga_contra_factura: v.factura_paga_contra_factura === true,
  };
}

function etiquetaSerieFolioLocal(serie: string | null, folio: string): string {
  const s = (serie ?? '').trim();
  return s ? `${s}-${folio}` : folio;
}

/** Orden serie → número → folio (mismo que el registro y el Excel). */
export function ordenarFacturasLigadas<T extends FacturaLigadaRow>(
  filas: ReadonlyArray<T>,
): T[] {
  const num = (v: unknown) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return [...filas].sort((a, b) => {
    const sa = (a.serie ?? '').toUpperCase();
    const sb = (b.serie ?? '').toUpperCase();
    if (sa !== sb) return sa < sb ? -1 : 1;
    const na = num(a.folio_num);
    const nb = num(b.folio_num);
    if (na !== nb) {
      if (na == null) return 1;
      if (nb == null) return -1;
      return na - nb;
    }
    const fa = a.folio.toUpperCase();
    const fb = b.folio.toUpperCase();
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
}

export function miniDeFactura(f: FacturaLigadaRow): FacturaEmitidaMini {
  const total = Number(f.total);
  return {
    id: f.id,
    serie: f.serie ?? null,
    folio: f.folio,
    etiqueta: etiquetaSerieFolioLocal(f.serie, f.folio),
    uuid: f.uuid ?? null,
    fecha_emision: f.fecha_emision,
    total: Number.isFinite(total) ? total : 0,
    moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
    metodo_pago:
      f.metodo_pago === 'PUE' || f.metodo_pago === 'PPD' ? f.metodo_pago : null,
    tiene_pdf: !!f.pdf_path,
    tiene_xml: !!f.xml_path,
  };
}

/** Separa las ligadas NO borradas en vigentes (ordenadas) y canceladas. */
export function clasificarLigadas(filas: ReadonlyArray<FacturaLigadaRow>): {
  vigentes: FacturaLigadaRow[];
  canceladas: number;
} {
  const vivas = filas.filter(
    (f) => f.deleted_at == null || f.deleted_at === '',
  );
  return {
    vigentes: ordenarFacturasLigadas(
      vivas.filter((f) => f.estatus === 'VIGENTE'),
    ),
    canceladas: vivas.filter((f) => f.estatus === 'CANCELADA').length,
  };
}

/** Bloque ADITIVO `factura_servicio` del snapshot. */
export function bloqueFacturaServicio(
  v: VueloSolicitudRow,
  ligadas: ReadonlyArray<FacturaLigadaRow>,
  nombreSolicitante?: string | null,
): FacturaServicioBloque {
  const { vigentes, canceladas } = clasificarLigadas(ligadas);
  return {
    solicitud: solicitudDe(v, nombreSolicitante),
    por_facturar: esPorFacturar(v, vigentes.length),
    facturas: vigentes.map(miniDeFactura),
    canceladas,
  };
}

/** Campo ADITIVO `factura_servicio_resumen` por fila de las listas. */
export function resumenFacturaServicio(
  v: VueloSolicitudRow,
  ligadas: ReadonlyArray<FacturaLigadaRow>,
): FacturaServicioResumen {
  const { vigentes } = clasificarLigadas(ligadas);
  return {
    solicitada: !!v.factura_solicitada_at,
    por_facturar: esPorFacturar(v, vigentes.length),
    paga_contra_factura: v.factura_paga_contra_factura === true,
    facturas: vigentes.length,
  };
}

// ============================ DESTINATARIOS ============================

export type FuenteResponsables = 'CONFIG' | 'ROL_FACTURACION' | 'ADMINS';

export interface UsuarioAviso {
  id: string;
  nombre: string;
}

/**
 * ¿A quién le llega el aviso «Factura pedida»? Se ELIGE EL NIVEL primero
 * (responsables configurados → rol FACTURACION → ADMIN activos) y DESPUÉS se
 * excluye a quien pidió: si era el único del nivel, NADIE recibe aviso (él
 * ES facturación) — jamás se «baja» al siguiente nivel por eso.
 */
export function elegirDestinatarios(
  niveles: {
    config: ReadonlyArray<UsuarioAviso>;
    facturacion: ReadonlyArray<UsuarioAviso>;
    admins: ReadonlyArray<UsuarioAviso>;
  },
  excluirId?: string | null,
): { fuente: FuenteResponsables; destinatarios: UsuarioAviso[] } {
  const [fuente, lista]: [FuenteResponsables, ReadonlyArray<UsuarioAviso>] =
    niveles.config.length > 0
      ? ['CONFIG', niveles.config]
      : niveles.facturacion.length > 0
        ? ['ROL_FACTURACION', niveles.facturacion]
        : ['ADMINS', niveles.admins];
  const vistos = new Set<string>();
  const destinatarios = lista.filter((u) => {
    if (u.id === excluirId || vistos.has(u.id)) return false;
    vistos.add(u.id);
    return true;
  });
  return { fuente, destinatarios };
}

// ============================ TEXTOS DE AVISOS ============================

/** «27 sep» en hora Cancún (sin día de la semana); '' sin fecha. */
export function fechaDiaMes(iso: string | null | undefined): string {
  const t = fechaCortaCancun(iso);
  if (!t) return '';
  const partes = t.split(' ');
  return partes.length >= 3 ? partes.slice(1).join(' ') : t;
}

/** «#341» · «#341 y #342» · «#341, #342 y #343». */
export function folios(folios: ReadonlyArray<number>): string {
  const t = [...folios].sort((a, b) => a - b).map((f) => `#${f}`);
  if (t.length <= 1) return t.join('');
  return `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}`;
}

/**
 * Aviso `factura_solicitada` (§5): «Itzi pidió factura del vuelo #341 ·
 * Maqar · 27 sep · Total $8,050.40 USD.» (sin fecha o sin precio se omite
 * ese tramo — nunca «Total $0 USD»); de grupo: «… de los vuelos #341, #342 y
 * #343 (grupo G-12) · Maqar · 27 sep.». + « El cliente paga hasta recibir la
 * factura.» + « Nota: …».
 */
export function textoAvisoSolicitud(p: {
  actor: string;
  vuelos: ReadonlyArray<{
    folio: number;
    fecha_vuelo?: string | null;
    monto_total_usd?: unknown;
  }>;
  cliente?: string | null;
  grupoFolio?: number | null;
  pagaContraFactura?: boolean;
  nota?: string | null;
}): { titulo: string; cuerpo: string } {
  const ordenados = [...p.vuelos].sort((a, b) => a.folio - b.folio);
  const primero = ordenados[0];
  const esGrupo = ordenados.length > 1;
  const partes: string[] = [];
  let titulo: string;
  if (esGrupo) {
    const g = p.grupoFolio != null ? `G-${p.grupoFolio}` : null;
    titulo = g
      ? `Factura pedida: grupo ${g}`
      : `Factura pedida: vuelos ${folios(ordenados.map((v) => v.folio))}`;
    partes.push(
      `${p.actor} pidió factura de los vuelos ${folios(ordenados.map((v) => v.folio))}${g ? ` (grupo ${g})` : ''}`,
    );
  } else {
    titulo = `Factura pedida: vuelo #${primero?.folio ?? '?'}`;
    partes.push(`${p.actor} pidió factura del vuelo #${primero?.folio ?? '?'}`);
  }
  if (p.cliente) partes.push(p.cliente);
  const fecha = fechaDiaMes(primero?.fecha_vuelo ?? null);
  if (fecha) partes.push(fecha);
  if (!esGrupo) {
    const total = Number(primero?.monto_total_usd);
    if (Number.isFinite(total) && total > 0) {
      partes.push(`Total ${fmtDineroTexto(total, 'USD')}`);
    }
  }
  let cuerpo = `${partes.join(' · ')}.`;
  if (p.pagaContraFactura)
    cuerpo += ' El cliente paga hasta recibir la factura.';
  const nota = (p.nota ?? '').trim();
  if (nota) cuerpo += ` Nota: ${nota}`;
  return { titulo, cuerpo };
}

/**
 * Aviso `factura_emitida` (§5) a quien pidió: «Ya está la factura A-123» /
 * «Mary Cruz registró la factura A-123 del vuelo #341 · Maqar.» (varios:
 * «… de los vuelos #341 y #342 · Maqar.»).
 */
export function textoAvisoEmitida(p: {
  actor: string;
  etiqueta: string;
  folios: ReadonlyArray<number>;
  cliente?: string | null;
}): { titulo: string; cuerpo: string } {
  const lista = folios(p.folios);
  const de =
    p.folios.length > 1 ? `de los vuelos ${lista}` : `del vuelo ${lista}`;
  const cliente = p.cliente ? ` · ${p.cliente}` : '';
  return {
    titulo: `Ya está la factura ${p.etiqueta}`,
    cuerpo: `${p.actor} registró la factura ${p.etiqueta} ${de}${cliente}.`,
  };
}

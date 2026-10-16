/**
 * «NECESITO FACTURA» — SOLICITUD DE FACTURA POR VUELO (24-sep-2026), LÓGICA
 * PURA con spec.
 *
 * Pedido de Itzi (audio): «que haya algo que yo marque así como de necesito
 * factura … y a Mari le salga una alertita de que ese vuelo tiene que ser
 * primero facturado para que el cliente pague … que le salga como el
 * pendiente de factura. Porque no en todos los vuelos hacemos facturas».
 *
 * «POR FACTURAR» ES DERIVADO — nunca se guarda (`estadoSolicitud`, definición
 * ÚNICA del contrato §3.8). Cuatro estados: solicitada AND vuelo no
 * CANCELADO AND sin CFDI del PAC (`facturado`) AND sin factura emitida
 * VIGENTE ligada AND —desde el 13-oct-2026 (caso #376, invariante 65)— sin
 * el estatus MANUAL «Facturado» (`factura_estatus`) AND —desde el 0.0.77
 * (14-oct-2026, invariante 60)— no es una solicitud AUTOMÁTICA cuyo vuelo ya
 * no exige factura (`YA_NO_APLICA`: sale de la bandeja y del badge y viaja
 * en el aditivo `ya_no_aplican`; la decide el DINERO, no el estado del
 * vuelo; una manual nunca). Un vuelo pedido, sin factura registrada y
 * marcado «Facturado» a mano YA NO cuenta como por facturar (ni en la
 * bandeja ni en el badge): es `MARCADO_SIN_REGISTRO` y viaja aparte, en la
 * NOTA aditiva `marcados_sin_registro`, para que la oficina registre su
 * factura. ELABORADA_ENVIADA sigue por facturar (la factura no está
 * registrada y el cliente puede estar esperándola).
 */
import { fechaCortaCancun } from '../../common/fecha-cancun.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import {
  cobroExigeFactura,
  type CobroExigeFacturaRow,
  type ExigenciaFacturaVuelo,
} from '../../common/cuentas-cobro';
import type {
  FacturaEmitidaMini,
  FacturaServicioBloque,
  FacturaServicioResumen,
  SolicitudFactura,
} from '../facturas-emitidas/facturas-emitidas.types';
import type { FacturaDeVuelo } from './factura-cliente-etiquetas';

/** Columnas de la solicitud en `vuelo` (migración 20260924000003). */
export const COLS_SOLICITUD_FACTURA =
  'factura_solicitada_at, factura_solicitada_por, factura_solicitud_nota, factura_paga_contra_factura';

/** Tope de la nota (mismo que el CHECK `vuelo_factura_solicitud_nota_chk`). */
export const LIMITE_NOTA_SOLICITUD = 500;

/**
 * Nota que deja la SOLICITUD AUTOMÁTICA por un cobro que exige factura
 * (13-oct-2026, invariante 60): «Solicitada automáticamente: cobro en HSBC
 * Pesos» / «… cobro por Transferencia» (`origenCobroTexto`), recortada al
 * tope del CHECK.
 */
export const PREFIJO_NOTA_SOLICITUD_AUTOMATICA =
  'Solicitada automáticamente: cobro ';

export function notaSolicitudAutomatica(origen: string): string {
  return (PREFIJO_NOTA_SOLICITUD_AUTOMATICA + origen).slice(
    0,
    LIMITE_NOTA_SOLICITUD,
  );
}

export interface VueloSolicitudRow {
  id?: string;
  estado?: string | null;
  facturado?: boolean | null;
  /** Estatus MANUAL de la factura del servicio (SIN_FACTURA /
   *  ELABORADA_ENVIADA / FACTURADO). Sin la llave (lector que no la trae)
   *  la regla se comporta como antes del 13-oct-2026. */
  factura_estatus?: string | null;
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
  /** anticipo/finiquito (16-oct-2026: ya no decide alertas; se informa). */
  es_parcial?: boolean | null;
}

/** Columnas de la factura embebida en el puente para el bloque/resumen. */
export const COLS_FACTURA_LIGADA =
  'id, serie, folio, folio_num, uuid, fecha_emision, estatus, total, moneda, metodo_pago, pdf_path, xml_path, deleted_at, es_parcial';

/**
 * Estado de la SOLICITUD de factura de un vuelo (13-oct-2026, invariante 65;
 * YA_NO_APLICA desde el 0.0.77, invariante 60):
 *  - 'POR_FACTURAR': solicitada AND no CANCELADO AND `facturado` (CFDI del
 *    PAC) ≠ true AND 0 facturas emitidas VIGENTES (no borradas) ligadas AND
 *    estatus manual ≠ FACTURADO AND no YA_NO_APLICA. Bandeja «Por facturar»
 *    y badge del menú.
 *  - 'MARCADO_SIN_REGISTRO': lo mismo pero el vuelo está marcado
 *    «Facturado» a mano (gana sobre YA_NO_APLICA: alguien dice que ya se
 *    facturó). Sale de la bandeja y del badge y va en la nota
 *    `marcados_sin_registro` («registra su factura aquí»).
 *  - 'YA_NO_APLICA': lo mismo pero es una solicitud AUTOMÁTICA
 *    (`esSolicitudAutomatica`) y el vuelo ya no exige factura (el dinero se
 *    devolvió, o se corrigió o eliminó el cobro: «un anticipo devuelto no
 *    lleva factura», decisión del cliente del 14-oct-2026). NO se retira
 *    sola (retirar es destructivo y pide confirmación): sale de la bandeja y
 *    del badge y viaja en el aditivo `ya_no_aplican`.
 *  - 'NINGUNO': cualquier otro caso (sin solicitud, cancelado, CFDI del PAC
 *    o con factura VIGENTE ligada).
 */
export type EstadoSolicitudFactura =
  | 'POR_FACTURAR'
  | 'MARCADO_SIN_REGISTRO'
  | 'YA_NO_APLICA'
  | 'NINGUNO';

/** ¿Alguien pidió factura (`factura_solicitada_at` con valor)? */
function solicitudPedida(v: VueloSolicitudRow): boolean {
  return v.factura_solicitada_at != null && v.factura_solicitada_at !== '';
}

/**
 * Solicitud AUTOMÁTICA (14-oct-2026): pedida y con la nota que deja
 * `solicitarPorCobro` (empieza EXACTO con `PREFIJO_NOTA_SOLICITUD_AUTOMATICA`).
 * Si la oficina edita la nota deja de serlo: la decidió una persona. NO mira
 * el estado del vuelo.
 */
export function esSolicitudAutomatica(
  v: VueloSolicitudRow | null | undefined,
): boolean {
  if (!v || !solicitudPedida(v)) return false;
  const nota = v.factura_solicitud_nota;
  return (
    typeof nota === 'string' &&
    nota.startsWith(PREFIJO_NOTA_SOLICITUD_AUTOMATICA)
  );
}

/**
 * La solicitud AUTOMÁTICA ya no aplica (14-oct-2026, invariante 60):
 * automática AND exigencia LEÍDA (≠ null) AND ≠ 'EXIGE'. NO mira el estado
 * del vuelo (el panel pinta su chip gris también en un cancelado). Una
 * manual jamás; `exigencia` null (no leída) ⇒ false: como antes.
 */
export function solicitudYaNoAplica(
  v: VueloSolicitudRow | null | undefined,
  exigencia: ExigenciaFacturaVuelo | null,
): boolean {
  return esSolicitudAutomatica(v) && exigencia != null && exigencia !== 'EXIGE';
}

/**
 * DEFINICIÓN ÚNICA de la regla (ver `EstadoSolicitudFactura`). El 3.er
 * parámetro es OBLIGATORIO desde el 0.0.77 (revisión F8): `exigencia` del
 * vuelo (`vueloExigeFactura` vía `facturasDeVuelos` / `exigenciasDeAutomaticas`)
 * o `null` = no leída ⇒ se comporta como antes (nunca YA_NO_APLICA). Así cada
 * lector decide de forma explícita.
 */
export function estadoSolicitud(
  v: VueloSolicitudRow | null | undefined,
  vigentesLigadas: number,
  exigencia: ExigenciaFacturaVuelo | null,
): EstadoSolicitudFactura {
  if (!v) return 'NINGUNO';
  const viva =
    solicitudPedida(v) &&
    v.estado !== 'CANCELADO' &&
    v.facturado !== true &&
    vigentesLigadas === 0;
  if (!viva) return 'NINGUNO';
  if (v.factura_estatus === 'FACTURADO') return 'MARCADO_SIN_REGISTRO';
  if (solicitudYaNoAplica(v, exigencia)) return 'YA_NO_APLICA';
  return 'POR_FACTURAR';
}

/** «Por facturar» (§3.8): `estadoSolicitud` === 'POR_FACTURAR'. */
export function esPorFacturar(
  v: VueloSolicitudRow | null | undefined,
  vigentesLigadas: number,
  exigencia: ExigenciaFacturaVuelo | null,
): boolean {
  return estadoSolicitud(v, vigentesLigadas, exigencia) === 'POR_FACTURAR';
}

/** Pedida, sin factura registrada y marcada «Facturado» a mano (13-oct-2026). */
export function esMarcadoSinRegistro(
  v: VueloSolicitudRow | null | undefined,
  vigentesLigadas: number,
  exigencia: ExigenciaFacturaVuelo | null,
): boolean {
  return (
    estadoSolicitud(v, vigentesLigadas, exigencia) === 'MARCADO_SIN_REGISTRO'
  );
}

/** Solicitud automática viva cuyo vuelo ya no exige factura (0.0.77). */
export function esSolicitudYaNoAplica(
  v: VueloSolicitudRow | null | undefined,
  vigentesLigadas: number,
  exigencia: ExigenciaFacturaVuelo | null,
): boolean {
  return estadoSolicitud(v, vigentesLigadas, exigencia) === 'YA_NO_APLICA';
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

/**
 * Cobros ASIGNABLES a una factura (invariante 84): positivos y sin sobre de
 * grupo (un reembolso y la parte de un sobre nunca llevan factura).
 */
export function cobrosAsignables<T extends CobroParaFactura>(
  cobros: ReadonlyArray<T>,
): T[] {
  return cobros.filter((c) => {
    const m = Number(c.monto);
    const sobre = c.cobro_grupo_id;
    return Number.isFinite(m) && m > 0 && !(typeof sobre === 'string' && sobre);
  });
}

/** ¿El cobro no tiene factura asignada (`factura_emitida_id` null/ausente)? */
export function cobroSinFactura(c: CobroParaFactura): boolean {
  return !(typeof c.factura_emitida_id === 'string' && c.factura_emitida_id);
}

/**
 * `cobros_n` / `cobros_monto` (Σ BRUTA por moneda, redondeo a centavos) de
 * los cobros de UN vuelo que ampara la factura `facturaId`. Orden de las
 * monedas: USD y luego MXN (solo las que suman algo).
 */
export function resumenCobrosDeFactura(
  facturaId: string,
  cobros: ReadonlyArray<CobroParaFactura>,
): Pick<FacturaEmitidaMini, 'cobros_n' | 'cobros_monto'> {
  const propios = cobrosAsignables(cobros).filter(
    (c) => c.factura_emitida_id === facturaId,
  );
  const suma = { USD: 0, MXN: 0 };
  for (const c of propios) {
    const moneda = c.moneda === 'USD' ? 'USD' : 'MXN';
    suma[moneda] += Number(c.monto);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    cobros_n: propios.length,
    cobros_monto: (['USD', 'MXN'] as const)
      .filter((m) => suma[m] > 0)
      .map((m) => ({ moneda: m, monto: r2(suma[m]) })),
  };
}

/**
 * Mini de la burbuja. `cobros` = los del VUELO (lector `facturasDeVuelos`
 * con `conCobros`), SOLO con la sonda de 20261016000001: sin ella se pasa
 * `[]` y salen `cobros_n: 0`, `cobros_monto: []`.
 */
export function miniDeFactura(
  f: FacturaLigadaRow,
  cobros: ReadonlyArray<CobroParaFactura> = [],
): FacturaEmitidaMini {
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
    // ADITIVOS (16-oct-2026, invariante 84), últimas llaves y en este orden.
    es_parcial: f.es_parcial === true,
    ...resumenCobrosDeFactura(f.id, cobros),
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

/**
 * Bloque ADITIVO `factura_servicio` del snapshot. `f` = la factura del vuelo
 * leída por `facturasDeVuelos` (exigencia y orígenes que la exigen) o `null`
 * si no se pudo leer (el bloque sale igual: `exigencia: null`,
 * `origenes_exigen: []`, `solicitud_ya_no_aplica: false`).
 */
export function bloqueFacturaServicio(
  v: VueloSolicitudRow,
  ligadas: ReadonlyArray<FacturaLigadaRow>,
  nombreSolicitante: string | null | undefined,
  f:
    | (Pick<FacturaDeVuelo, 'exigencia' | 'origenes_exigen'> & {
        cobros?: ReadonlyArray<CobroParaFactura>;
      })
    | null,
  /** La sonda de 20261016000001 (invariante 84): sin ella 0/[]/false. */
  asignacionDisponible = false,
): FacturaServicioBloque {
  const { vigentes, canceladas } = clasificarLigadas(ligadas);
  const exigencia = f?.exigencia ?? null;
  // FACTURAS POR COBRO (16-oct-2026, invariante 84): cobros positivos sin
  // sobre del vuelo; los que no ampara ninguna factura y, de esos, los que
  // exigen factura (deciden el tono del chip del panel).
  const asignables = asignacionDisponible
    ? cobrosAsignables(f?.cobros ?? [])
    : [];
  const sinFactura = asignables.filter(cobroSinFactura);
  return {
    solicitud: solicitudDe(v, nombreSolicitante),
    por_facturar: esPorFacturar(v, vigentes.length, exigencia),
    facturas: vigentes.map((x) => miniDeFactura(x, asignables)),
    canceladas,
    // ADITIVO (13-oct-2026, invariante 65): pedida, sin VIGENTE ligada y
    // marcada «Facturado» a mano (ya NO cuenta como por_facturar).
    marcado_sin_registro: esMarcadoSinRegistro(v, vigentes.length, exigencia),
    // ADITIVOS (14-oct-2026, API 0.0.77, invariante 60), ÚLTIMAS llaves: la
    // exigencia la decide el API y el panel solo la pinta (su espejo queda
    // como respaldo de un API ≤ 0.0.76). `solicitud_ya_no_aplica` NO mira el
    // estado del vuelo (chip gris también en un cancelado).
    exigencia,
    origenes_exigen: f ? [...f.origenes_exigen] : [],
    solicitud_ya_no_aplica: solicitudYaNoAplica(v, exigencia),
    // ADITIVOS (16-oct-2026, invariante 84), ÚLTIMAS llaves y en este orden.
    cobros_sin_factura: sinFactura.length,
    cobros_sin_factura_exigen: sinFactura.filter(cobroExigeFactura).length,
    asignacion_disponible: asignacionDisponible,
  };
}

/**
 * Campo ADITIVO `factura_servicio_resumen` por fila de las listas (forma sin
 * cambio). `exigencia` = la de `exigenciasDeAutomaticas` (solo vuelos con
 * solicitud automática viva) o null: su `por_facturar` ya excluye
 * YA_NO_APLICA.
 */
export function resumenFacturaServicio(
  v: VueloSolicitudRow,
  ligadas: ReadonlyArray<FacturaLigadaRow>,
  exigencia: ExigenciaFacturaVuelo | null,
): FacturaServicioResumen {
  const { vigentes } = clasificarLigadas(ligadas);
  return {
    solicitada: !!v.factura_solicitada_at,
    por_facturar: esPorFacturar(v, vigentes.length, exigencia),
    paga_contra_factura: v.factura_paga_contra_factura === true,
    facturas: vigentes.length,
  };
}

// ================= SOLICITUD AUTOMÁTICA: TRANSICIONES (0.0.77) =================

/**
 * Un cobro tal como lo lee `facturasDeVuelos({ conCobros: true })`. Desde el
 * 16-oct-2026 (invariante 84) trae además `vuelo_id`, `fecha_cobro`,
 * `cobro_grupo_id` y —SOLO con la sonda de 20261016000001—
 * `factura_emitida_id` (la factura que lo ampara; null = ninguna).
 */
export type CobroParaFactura = CobroExigeFacturaRow & {
  id?: string | null;
  vuelo_id?: unknown;
  fecha_cobro?: unknown;
  cobro_grupo_id?: unknown;
  factura_emitida_id?: unknown;
};

/**
 * El cambio de dinero que acaba de pasar en un vuelo (14-oct-2026,
 * invariante 60): ALTA (cobro o reembolso nuevo, por su id), BAJA (la fila
 * borrada completa) o CAMBIO (el id y la fila con sus valores de ANTES).
 */
export type CambioDeCobro =
  | { tipo: 'ALTA'; cobroId: string }
  | { tipo: 'BAJA'; fila: CobroParaFactura }
  | { tipo: 'CAMBIO'; cobroId: string; antes: CobroParaFactura };

/** Por qué cambió el dinero (texto del aviso y `data.motivo`). */
export type MotivoCambioSolicitud =
  | 'COBRO_NUEVO'
  | 'REEMBOLSO'
  | 'COBRO_CORREGIDO'
  | 'COBRO_ELIMINADO';

/** Transición de una solicitud automática viva. */
export type TransicionSolicitudAutomatica = 'YA_NO_APLICA' | 'VUELVE_A_APLICAR';

/** Tipos de notificación (≤ 60 caracteres; la app pone el ícono por defecto). */
export const TIPO_AVISO_SOLICITUD_YA_NO_APLICA =
  'factura_solicitud_ya_no_aplica';
export const TIPO_AVISO_SOLICITUD_VUELVE_A_APLICAR =
  'factura_solicitud_vuelve_a_aplicar';

/** Campos de dinero de un cobro (los que decide `vueloExigeFactura`). */
const CAMPOS_DINERO_COBRO = [
  'monto',
  'moneda',
  'cuenta_destino',
  'metodo_cobro',
  'tc_usd_mxn',
] as const;

/**
 * Los cobros del vuelo ANTES del cambio, CONTRAFACTUAL sobre los de DESPUÉS
 * (sin leer antes de escribir: cero latencia en el POST del outbox): ALTA ⇒
 * sin la fila nueva; BAJA ⇒ + la fila borrada; CAMBIO ⇒ la fila del id con
 * sus valores de ANTES (solo los campos de dinero presentes en `antes`; si
 * la fila ya no está, se agrega `antes`). Puro.
 */
export function cobrosAntesDelCambio(
  despues: ReadonlyArray<CobroParaFactura>,
  cambio: CambioDeCobro,
): CobroParaFactura[] {
  if (cambio.tipo === 'ALTA') {
    return despues.filter((c) => c.id !== cambio.cobroId);
  }
  if (cambio.tipo === 'BAJA') return [...despues, cambio.fila];
  const dineroAntes: Record<string, unknown> = {};
  for (const k of CAMPOS_DINERO_COBRO) {
    if (Object.prototype.hasOwnProperty.call(cambio.antes, k)) {
      dineroAntes[k] = cambio.antes[k];
    }
  }
  let visto = false;
  const out = despues.map((c): CobroParaFactura => {
    if (c.id !== cambio.cobroId) return c;
    visto = true;
    return { ...c, ...dineroAntes };
  });
  return visto ? out : [...out, { ...cambio.antes, id: cambio.cobroId }];
}

/**
 * Se avisa la TRANSICIÓN, no el estado (revisión F14): EXIGE ⇒ no exige =
 * 'YA_NO_APLICA'; no exige ⇒ EXIGE = 'VUELVE_A_APLICAR'; si no, null (un 2.º
 * reembolso o borrar otro cobro no repite el aviso).
 */
export function transicionSolicitudAutomatica(
  antes: ExigenciaFacturaVuelo,
  despues: ExigenciaFacturaVuelo,
): TransicionSolicitudAutomatica | null {
  if (antes === 'EXIGE' && despues !== 'EXIGE') return 'YA_NO_APLICA';
  if (antes !== 'EXIGE' && despues === 'EXIGE') return 'VUELVE_A_APLICAR';
  return null;
}

/**
 * Link del aviso de transición. YA_NO_APLICA ⇒ el DETALLE DEL VUELO en su
 * tarjeta de cobros (`/admin/flights/<id>#cobros`), donde CUALQUIER panel
 * ofrece «Retirar» (revisión del 14-oct-2026: la tarjeta «ya no aplican» de
 * la bandeja solo existe en el panel nuevo, y con el API 0.0.77 y el panel
 * de antes el enlace aterrizaba en una bandeja sin el vuelo);
 * VUELVE_A_APLICAR ⇒ la tarjeta «Por facturar» (`por-facturar`).
 */
export function linkAvisoCambioSolicitud(
  vueloId: string,
  transicion: TransicionSolicitudAutomatica,
): string {
  if (transicion === 'YA_NO_APLICA') return `/admin/flights/${vueloId}#cobros`;
  return `/admin/facturas-emitidas?resaltar=${vueloId}#por-facturar`;
}

/**
 * Textos del aviso de transición de una solicitud AUTOMÁTICA (14-oct-2026,
 * invariante 60). Tramos vacíos se omiten (como `textoAvisoSolicitud`):
 * «vuelo #341 · Maqar · 27 sep». `origen` = `origenCobroTexto` de la fila
 * del cambio (solo lo cita «Entró dinero …»); `eraReembolso` = la fila
 * borrada era un reembolso (COBRO_ELIMINADO). Un cobro NUEVO nunca quita la
 * exigencia (solo sube sumas y lo cobrado): su texto de «ya no aplica» es
 * defensivo.
 */
export function textoAvisoCambioSolicitud(p: {
  transicion: TransicionSolicitudAutomatica;
  motivo: MotivoCambioSolicitud;
  vuelo: { folio: number; fecha_vuelo?: string | null };
  cliente?: string | null;
  origen?: string | null;
  eraReembolso?: boolean;
}): { titulo: string; cuerpo: string } {
  const folio = `#${p.vuelo.folio}`;
  const vuelo = [
    `vuelo ${folio}`,
    (p.cliente ?? '').trim() || null,
    fechaDiaMes(p.vuelo.fecha_vuelo ?? null) || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const fila = p.eraReembolso === true ? 'un reembolso' : 'un cobro';
  if (p.transicion === 'YA_NO_APLICA') {
    const cola =
      ' Su solicitud automática salió de «Por facturar»; retírala desde el detalle del vuelo (botón «Retirar»).';
    const sinDinero =
      'ya no quedó dinero en una cuenta que exija factura.' + cola;
    let cuerpo: string;
    switch (p.motivo) {
      case 'REEMBOLSO':
        cuerpo = `Se registró la devolución del dinero del ${vuelo}: un anticipo devuelto no lleva factura.${cola}`;
        break;
      case 'COBRO_CORREGIDO':
        cuerpo = `Se corrigió un cobro del ${vuelo}: ${sinDinero}`;
        break;
      case 'COBRO_ELIMINADO':
        cuerpo = `Se eliminó ${fila} del ${vuelo}: ${sinDinero}`;
        break;
      default:
        cuerpo = `Se registró un cobro del ${vuelo}: ${sinDinero}`;
    }
    return { titulo: `Ya no aplica: factura del vuelo ${folio}`, cuerpo };
  }
  const regreso =
    'quedó dinero en una cuenta que exige factura; su solicitud automática regresó a «Por facturar».';
  let cuerpo: string;
  switch (p.motivo) {
    case 'COBRO_NUEVO': {
      const origen = (p.origen ?? '').trim();
      cuerpo = `Entró dinero al ${vuelo}${origen ? ` (cobro ${origen})` : ''} y quedó en una cuenta que exige factura: su solicitud automática regresó a «Por facturar».`;
      break;
    }
    case 'COBRO_CORREGIDO':
      cuerpo = `Se corrigió un cobro del ${vuelo}: ${regreso}`;
      break;
    case 'COBRO_ELIMINADO':
      cuerpo = `Se eliminó ${fila} del ${vuelo}: ${regreso}`;
      break;
    default:
      cuerpo = `Se registró un reembolso del ${vuelo}: ${regreso}`;
  }
  return { titulo: `Vuelve a aplicar: factura del vuelo ${folio}`, cuerpo };
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
 *
 * SOLICITUD AUTOMÁTICA por un cobro (13-oct-2026, invariante 60; campo
 * OPCIONAL `automatica`, sin él la salida es byte-idéntica): título «Factura
 * pendiente: vuelo #341» (grupo: «Factura pendiente: grupo G-12» / «Factura
 * pendiente: vuelos #341, #342 y #343») y cuerpo «Cobro en HSBC Pesos
 * registrado por Itzi: el vuelo #341 necesita factura · Maqar · 27 sep ·
 * Total $8,050.40 USD.» (grupo: «… los vuelos #341, #342 y #343 (grupo
 * G-12) necesitan factura · Maqar · 27 sep.»). Sin el tramo «El cliente paga
 * hasta recibir la factura.» (siempre false) ni «Nota: …» (la nota
 * persistida ya dice lo mismo).
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
  /** Solicitud automática por un cobro: `origen` = «en HSBC Pesos» / «por Transferencia». */
  automatica?: { origen: string };
}): { titulo: string; cuerpo: string } {
  const ordenados = [...p.vuelos].sort((a, b) => a.folio - b.folio);
  const primero = ordenados[0];
  const esGrupo = ordenados.length > 1;
  const partes: string[] = [];
  let titulo: string;
  const lista = folios(ordenados.map((v) => v.folio));
  if (p.automatica) {
    const origen = p.automatica.origen;
    if (esGrupo) {
      const g = p.grupoFolio != null ? `G-${p.grupoFolio}` : null;
      titulo = g
        ? `Factura pendiente: grupo ${g}`
        : `Factura pendiente: vuelos ${lista}`;
      partes.push(
        `Cobro ${origen} registrado por ${p.actor}: los vuelos ${lista}${g ? ` (grupo ${g})` : ''} necesitan factura`,
      );
    } else {
      titulo = `Factura pendiente: vuelo #${primero?.folio ?? '?'}`;
      partes.push(
        `Cobro ${origen} registrado por ${p.actor}: el vuelo #${primero?.folio ?? '?'} necesita factura`,
      );
    }
  } else if (esGrupo) {
    const g = p.grupoFolio != null ? `G-${p.grupoFolio}` : null;
    titulo = g
      ? `Factura pedida: grupo ${g}`
      : `Factura pedida: vuelos ${lista}`;
    partes.push(
      `${p.actor} pidió factura de los vuelos ${lista}${g ? ` (grupo ${g})` : ''}`,
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
  if (!p.automatica) {
    if (p.pagaContraFactura)
      cuerpo += ' El cliente paga hasta recibir la factura.';
    const nota = (p.nota ?? '').trim();
    if (nota) cuerpo += ` Nota: ${nota}`;
  }
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

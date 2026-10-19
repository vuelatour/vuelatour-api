/**
 * GASTOS «POR PAGAR» (FECHA A FUTURO) — 19-oct-2026, API 0.0.95, migración
 * `20261019000001`, invariante 93. FUENTE ÚNICA PURA de las reglas (con
 * spec): tope de fecha por rol, la bandera al escribir, el estado de pago,
 * «marcar pagado» y TODOS los textos es-MX (400, Excel, recordatorio y
 * pre-cierre). Prohibido recalcular el estado de pago en otro lado.
 *
 * Pedido del cliente (19-oct-2026): «que se puedan capturar gastos a futuro
 * en la app y en el admin … cosas que ya sé que voy a pagar en efectivo al
 * día siguiente para que no se me olvide». Decisiones: hasta fin de mes,
 * para todos los roles, con estado «por pagar». La fecha del gasto sigue
 * siendo la FECHA DEL PAGO (13-oct-2026): un gasto con fecha futura nace
 * «por pagar» y se confirma con «Marcar pagado» (fecha ≤ hoy).
 */
import { fechaInicioCorta } from '../../common/inicio-oficial.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import {
  CATEGORIA_NOMINA,
  etiquetaCategoriaGasto,
} from '../../common/categoria-gasto.util';
import { Rol } from '../../common/types/auth.types';

/** Estado de pago de un gasto (lo derivan los lectores, nunca se guarda). */
export type EstadoPagoGasto = 'PAGADO' | 'POR_PAGAR' | 'VENCIDO';

/** Código del 400 cuando la fecha final queda después de hoy sin «por pagar». */
export const CODIGO_POR_PAGAR_FECHA_FUTURA = 'POR_PAGAR_FECHA_FUTURA';

/** Texto del 400 `POR_PAGAR_FECHA_FUTURA` (panel y app lo enseñan tal cual). */
export const MENSAJE_POR_PAGAR_FECHA_FUTURA =
  'Un gasto con fecha futura queda por pagar: márcalo pagado el día que lo pagues (la fecha del gasto es la del pago).';

/**
 * 409 `GASTO_CONCILIADO` al re-programar («por pagar» otra vez) un gasto que
 * el banco ya cubrió: el cargo ES su pago.
 */
export const MENSAJE_POR_PAGAR_CONCILIADO =
  'Este gasto ya está conciliado con el banco: el cargo es su pago y no se pone «por pagar». Si ese cargo no es su pago, desvincúlalo primero en Conciliación.';

/** Tope hacia adelante de la OFICINA (sin cambio: ya era su banda). */
export const TOPE_FUTURO_OFICINA_DIAS = 30;

/**
 * Llaves que puede traer un PATCH que SOLO marca pagado (la excepción a la
 * ventana semanal del dueño de campo, contrato §3).
 */
export const LLAVES_PATCH_MARCAR_PAGADO = [
  'por_pagar',
  'fecha_gasto',
  'if_updated_at',
  'capturado_en',
] as const;

const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es un día de pared YYYY-MM-DD que existe en el calendario? */
export function esDiaValido(dia: unknown): dia is string {
  if (typeof dia !== 'string') return false;
  const m = RE_DIA.exec(dia);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dia;
}

/** `dia` + `n` días calendario (aritmética a mediodía UTC: sin husos). */
export function sumarDias(dia: string, n: number): string {
  const m = RE_DIA.exec(dia);
  if (!m) throw new Error(`Fecha inválida: ${dia}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return new Date(ms + n * 86_400_000).toISOString().slice(0, 10);
}

/** Último día del mes del `hoy` Cancún ('2026-10-19' ⇒ '2026-10-31'). */
export function finDeMesCancun(hoy: string): string {
  const m = RE_DIA.exec(hoy);
  if (!m) throw new Error(`Fecha inválida: ${hoy}`);
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(ultimo).padStart(2, '0')}`;
}

/** PILOTO, MECANICO y VISITANTE (capturan desde la app). */
export function esRolCampo(rol: Rol | string | null | undefined): boolean {
  return rol === Rol.PILOTO || rol === Rol.MECANICO || rol === Rol.VISITANTE;
}

/**
 * Fecha MÁXIMA de un gasto para el rol (contrato §2):
 *  - CAMPO: con la migración, `max(finDeMes(hoy), hoy + 1)` — el último día
 *    del mes sigue aceptando mañana, como antes —; sin ella, `hoy + 1` (lo
 *    de siempre).
 *  - OFICINA: `hoy + 30` (sin cambio, con o sin la migración).
 */
export function fechaMaxGasto(
  hoy: string,
  rol: Rol | string | null | undefined,
  conPorPagar = true,
): string {
  if (!esRolCampo(rol)) return sumarDias(hoy, TOPE_FUTURO_OFICINA_DIAS);
  const manana = sumarDias(hoy, 1);
  if (!conPorPagar) return manana;
  const fin = finDeMesCancun(hoy);
  return fin > manana ? fin : manana;
}

/** 'YYYY-MM-DD' ⇒ 'dd/mm/aaaa' (los 400 de fecha de siempre). */
export function fechaBonita(dia: string): string {
  return dia.slice(0, 10).split('-').reverse().join('/');
}

/**
 * 400 de un rol de CAMPO con la fecha después del tope y la migración
 * aplicada: «La fecha del gasto (dd/mm/aaaa) es después de fin de mes: los
 * gastos por pagar se capturan a lo más hasta el último día del mes
 * (dd/mm/aaaa).» (el segundo es el último día del mes de HOY).
 */
export function mensajeFechaDespuesDeFinDeMes(
  fecha: string,
  hoy: string,
): string {
  return `La fecha del gasto (${fechaBonita(fecha)}) es después de fin de mes: los gastos por pagar se capturan a lo más hasta el último día del mes (${fechaBonita(finDeMesCancun(hoy))}).`;
}

/** Resultado de `porPagarFinal`. */
export type DecisionPorPagar =
  | { ok: true; por_pagar: boolean }
  | {
      ok: false;
      error: {
        message: string;
        error: typeof CODIGO_POR_PAGAR_FECHA_FUTURA;
        details: { fecha_gasto: string; hoy: string };
      };
    };

/**
 * La bandera que se ESCRIBE (contrato §2):
 *  - fecha final > hoy ⇒ `true` (con `enviado === false` ⇒ 400
 *    POR_PAGAR_FECHA_FUTURA);
 *  - si no ⇒ `enviado ?? vigente ?? false` («lo anoto hoy y lo pago al rato»
 *    con `true` se acepta).
 * `diaCaptura` (solo el ALTA, día Cancún del `capturado_en` de la app): un
 * gasto capturado CON fecha a futuro que el outbox sube cuando esa fecha ya
 * pasó sigue «por pagar» (VENCIDO) si no dijo lo contrario — jamás se
 * afirma pagado lo que se capturó para pagarse después.
 */
export function porPagarFinal(args: {
  fechaFinal: string;
  hoy: string;
  enviado?: boolean | null;
  vigente?: boolean | null;
  diaCaptura?: string | null;
}): DecisionPorPagar {
  const fecha = args.fechaFinal.slice(0, 10);
  if (fecha > args.hoy) {
    if (args.enviado === false) {
      return {
        ok: false,
        error: {
          message: MENSAJE_POR_PAGAR_FECHA_FUTURA,
          error: CODIGO_POR_PAGAR_FECHA_FUTURA,
          details: { fecha_gasto: fecha, hoy: args.hoy },
        },
      };
    }
    return { ok: true, por_pagar: true };
  }
  if (
    args.diaCaptura &&
    fecha > args.diaCaptura &&
    args.enviado !== false &&
    args.enviado !== true
  ) {
    return { ok: true, por_pagar: true };
  }
  return { ok: true, por_pagar: args.enviado ?? args.vigente ?? false };
}

/**
 * Estado de pago (contrato §2): conciliado ⇒ PAGADO (el banco prueba el
 * pago aunque la columna siga en true); sin `por_pagar` ⇒ PAGADO;
 * `fecha_gasto >= hoy` ⇒ POR_PAGAR; si no ⇒ VENCIDO. Una fecha ilegible de
 * un gasto por pagar ⇒ POR_PAGAR (jamás se afirma pagado).
 */
/**
 * Lo que el estado de pago lee de una fila de gasto (cualquier fila sirve:
 * sin `por_pagar` es PAGADO).
 */
export type FilaEstadoPago = {
  por_pagar?: unknown;
  conciliado?: unknown;
  fecha_gasto?: unknown;
  [otra: string]: unknown;
};

/** Día AAAA-MM-DD de un valor de PostgREST (texto); otro tipo ⇒ ''. */
function diaDe(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 10) : '';
}

export function estadoPagoGasto(
  g: FilaEstadoPago,
  hoy: string,
): EstadoPagoGasto {
  if (g.conciliado === true) return 'PAGADO';
  if (g.por_pagar !== true) return 'PAGADO';
  const dia = diaDe(g.fecha_gasto);
  if (!RE_DIA.test(dia)) return 'POR_PAGAR';
  return dia >= hoy ? 'POR_PAGAR' : 'VENCIDO';
}

/** «Por pagar vigente» = estado ≠ PAGADO (fuera del libro de caja chica). */
export function porPagarVigente(g: FilaEstadoPago, hoy: string): boolean {
  return estadoPagoGasto(g, hoy) !== 'PAGADO';
}

/** ¿El PATCH marca pagado un gasto por pagar? */
export function esMarcarPagado(
  dto: { por_pagar?: unknown },
  vigente: { por_pagar?: unknown } | null | undefined,
): boolean {
  return vigente?.por_pagar === true && dto.por_pagar === false;
}

/**
 * ¿El PATCH es EXCLUSIVAMENTE «marcar pagado»? (`por_pagar: false` y las
 * llaves con valor ⊆ {por_pagar, fecha_gasto, if_updated_at, capturado_en}).
 * Se decide por VALOR, no por presencia: la clase del DTO (target ES2022)
 * puede definir llaves en `undefined`.
 */
export function esPatchSoloMarcarPagado(dto: object): boolean {
  const d = dto as Record<string, unknown>;
  if (d.por_pagar !== false) return false;
  const permitidas = new Set<string>(LLAVES_PATCH_MARCAR_PAGADO);
  return Object.keys(d).every((k) => d[k] === undefined || permitidas.has(k));
}

/**
 * Fecha del PAGO al marcar pagado: la enviada; si no, hoy cuando la fecha
 * vigente es futura, o la vigente (un VENCIDO conserva su día).
 */
export function fechaMarcarPagado(
  enviada: string | null | undefined,
  vigente: string,
  hoy: string,
): string {
  if (typeof enviada === 'string' && enviada.length >= 10) {
    return enviada.slice(0, 10);
  }
  const dia = vigente.slice(0, 10);
  return dia > hoy ? hoy : dia;
}

/**
 * Agrega `estado_pago` a una fila de gasto SOLO si trae la llave
 * `por_pagar` (= se leyó con la migración): sin ella la fila sale igual.
 */
export function conEstadoPago<T extends object>(
  fila: T,
  hoy: string,
): T & { estado_pago?: EstadoPagoGasto } {
  if (!fila || !('por_pagar' in fila)) return fila;
  return {
    ...fila,
    estado_pago: estadoPagoGasto(fila, hoy),
  };
}

/** Igual que `conEstadoPago`, mutando cada fila (listas grandes). */
export function anexarEstadoPago(
  filas: Array<Record<string, unknown>>,
  hoy: string,
): void {
  for (const f of filas) {
    if (f && 'por_pagar' in f) f.estado_pago = estadoPagoGasto(f, hoy);
  }
}

/**
 * Celda «Pago» del Excel de gastos: «Por pagar · vence 20-oct-2026» /
 * «Vencido desde 20-oct-2026» / vacía (pagado).
 */
export function celdaPagoExcel(g: FilaEstadoPago, hoy: string): string {
  const estado = estadoPagoGasto(g, hoy);
  if (estado === 'PAGADO') return '';
  const dia = diaDe(g.fecha_gasto);
  const corta = RE_DIA.test(dia) ? fechaInicioCorta(dia) : dia;
  return estado === 'POR_PAGAR'
    ? `Por pagar · vence ${corta}`
    : `Vencido desde ${corta}`;
}

// ===== Recordatorio push (GastosPorPagarService) =====

/** `data.motivo` del aviso (la app abre el gasto para marcarlo pagado). */
export const MOTIVO_RECORDATORIO_POR_PAGAR = 'gasto_por_pagar';
/** Clave de `alerta_emitida` (sin fila en `alerta_config`: aviso directo). */
export const CLAVE_ALERTA_POR_PAGAR = 'gasto_por_pagar';
/** Link del aviso (Gastos del panel con el filtro). */
export const LINK_GASTOS_POR_PAGAR = '/admin/expenses?por_pagar=1';
/**
 * Link del aviso de una NÓMINA (revisión P2, 19-oct-2026): la nómina vive
 * solo en su módulo (invariante 91) y Gastos la excluye siempre.
 */
export const LINK_NOMINA = '/admin/nomina';
/** Título del aviso del día del pago. */
export const TITULO_RECORDATORIO_HOY = 'Gasto por pagar hoy';
/** Título del aviso del día siguiente (una vez). */
export const TITULO_RECORDATORIO_VENCIDO = 'Gasto por pagar vencido';

/**
 * Dedupe `gasto_por_pagar:<gasto_id>:<día Cancún>:<usuario_id>` (revisión
 * P15: uno POR DESTINATARIO; el aviso puede ir al dueño y a la oficina que
 * lo capturó a su nombre).
 */
export function claveRecordatorioPorPagar(
  gastoId: string,
  dia: string,
  usuarioId: string,
): string {
  return `${CLAVE_ALERTA_POR_PAGAR}:${gastoId}:${dia}:${usuarioId}`;
}

/**
 * Link del aviso: una NÓMINA ⇒ `/admin/nomina?mes=<YYYY-MM de su
 * fecha_gasto>` (P2); lo demás ⇒ Gastos con el filtro «Por pagar».
 */
export function linkRecordatorioPorPagar(g: {
  categoria?: string | null;
  fecha_gasto?: unknown;
}): string {
  if (g.categoria !== CATEGORIA_NOMINA) return LINK_GASTOS_POR_PAGAR;
  const mes = diaDe(g.fecha_gasto).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(mes) ? `${LINK_NOMINA}?mes=${mes}` : LINK_NOMINA;
}

/**
 * Cuerpo del aviso: «Taxi / estacionamiento · $500 MXN · vuelo #436 —
 * cuando lo pagues, márcalo pagado (Mis registros en la app, o Gastos en el
 * panel).» (sin vuelo, sin el tramo; dinero con `fmtDineroTexto`). Una
 * NÓMINA termina «— cuando lo pagues, márcalo pagado (Nómina en el
 * panel).» (P2).
 */
export function cuerpoRecordatorioPorPagar(g: {
  categoria?: string | null;
  monto?: unknown;
  moneda?: string | null;
  folio?: number | null;
}): string {
  const monto = Number(g.monto);
  const partes = [
    etiquetaCategoriaGasto(g.categoria ?? null) || 'Gasto',
    fmtDineroTexto(Number.isFinite(monto) ? monto : 0, g.moneda ?? null),
  ];
  if (typeof g.folio === 'number' && Number.isFinite(g.folio)) {
    partes.push(`vuelo #${g.folio}`);
  }
  const donde =
    g.categoria === CATEGORIA_NOMINA
      ? 'Nómina en el panel'
      : 'Mis registros en la app, o Gastos en el panel';
  return `${partes.join(' · ')} — cuando lo pagues, márcalo pagado (${donde}).`;
}

/** Lo que el recordatorio sabe de un usuario. */
export interface UsuarioRecordatorio {
  activo: boolean;
  rol: string | null;
}

/**
 * A quién le llega el recordatorio (revisión P15, 19-oct-2026): al DUEÑO del
 * gasto (`usuario_captura_id ?? created_by`, el mismo criterio de Mis
 * registros, Mi caja y la ventana de «Ya lo pagué») si está activo; y, si
 * `created_by` es OTRA persona, activa y de OFICINA (la que lo registró a
 * nombre del piloto), también a ella. Sin repetidos, el dueño primero.
 */
export function destinatariosRecordatorioPorPagar(
  g: { usuario_captura_id?: string | null; created_by?: string | null },
  usuarios: ReadonlyMap<string, UsuarioRecordatorio>,
): string[] {
  const out: string[] = [];
  const dueno = g.usuario_captura_id || g.created_by || null;
  if (dueno && usuarios.get(dueno)?.activo) out.push(dueno);
  const capturo = g.created_by || null;
  if (capturo && capturo !== dueno) {
    const u = usuarios.get(capturo);
    if (u?.activo && u.rol != null && !esRolCampo(u.rol)) out.push(capturo);
  }
  return out;
}

// ===== Pre-cierre (renglón BLOQUEANTE `gastos_por_pagar`) =====

/** Clave del renglón BLOQUEANTE del pre-cierre. */
export const CLAVE_PRECIERRE_GASTOS_POR_PAGAR = 'gastos_por_pagar';
/** Título del renglón. */
export const TITULO_PRECIERRE_GASTOS_POR_PAGAR =
  'Gastos por pagar sin confirmar';
/** Detalle con 0 gastos. */
export const DETALLE_PRECIERRE_SIN_POR_PAGAR =
  'Ningún gasto del periodo quedó por pagar.';
/** Detalle cuando la lectura falló. */
export const DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR =
  'No se pudieron verificar los gastos por pagar del periodo.';

/** Cuántos, cuántos vencidos y cuánto por moneda (jamás se suman). */
export interface ResumenGastosPorPagar {
  n: number;
  vencidos: number;
  mxn: number;
  usd: number;
}

/** Σ en centavos por moneda (MXN = todo lo que no es USD). */
export function resumenGastosPorPagar(
  gastos: ReadonlyArray<{
    monto?: unknown;
    moneda?: unknown;
    por_pagar?: unknown;
    conciliado?: unknown;
    fecha_gasto?: unknown;
  }>,
  hoy: string,
): ResumenGastosPorPagar {
  let mxn = 0;
  let usd = 0;
  let vencidos = 0;
  for (const g of gastos) {
    const n = Number(g.monto);
    const cents = Number.isFinite(n) ? Math.round(n * 100) : 0;
    if (g.moneda === 'USD') usd += cents;
    else mxn += cents;
    if (estadoPagoGasto(g, hoy) === 'VENCIDO') vencidos += 1;
  }
  return { n: gastos.length, vencidos, mxn: mxn / 100, usd: usd / 100 };
}

/**
 * Detalle del renglón: «3 gastos siguen «por pagar» (1 vencido): márcalos
 * pagados con la fecha real del pago, o elimínalos si no se pagaron.»;
 * 0 ⇒ `DETALLE_PRECIERRE_SIN_POR_PAGAR`; null (lectura caída) ⇒
 * `DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR`.
 */
export function detallePrecierreGastosPorPagar(
  r: ResumenGastosPorPagar | null,
): string {
  if (!r) return DETALLE_PRECIERRE_POR_PAGAR_SIN_VERIFICAR;
  if (r.n <= 0) return DETALLE_PRECIERRE_SIN_POR_PAGAR;
  const vencidos = r.vencidos === 1 ? '1 vencido' : `${r.vencidos} vencidos`;
  if (r.n === 1) {
    return `1 gasto sigue «por pagar» (${vencidos}): márcalo pagado con la fecha real del pago, o elimínalo si no se pagó.`;
  }
  return `${r.n} gastos siguen «por pagar» (${vencidos}): márcalos pagados con la fecha real del pago, o elimínalos si no se pagaron.`;
}

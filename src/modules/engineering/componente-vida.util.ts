/**
 * VIDA DE UN COMPONENTE DEL AVIÓN (17-nov-2026, API 0.0.140, invariante 135).
 *
 * Pedido del cliente: «esas listas de componentes limitados por tiempo saber
 * cuánto tiempo le queda a un foco, a una llanta o así». FUENTE ÚNICA y PURA
 * (sin BD, sin reloj: el día de hoy y el Hobbs entran por parámetro) de:
 *  - horas y días EN SERVICIO del componente;
 *  - horas y días que le QUEDAN contra sus límites;
 *  - el estado (vencido / por vencer / faltan datos / vigente / sin límite).
 *
 * El panel NO recalcula nada de esto: pinta lo que sale de aquí.
 *
 * Dos dimensiones, cada una opcional:
 *  - HORAS: aplica con `limite_horas`. Horas en servicio = `horas_previas` +
 *    (Hobbs del avión − `horas_aeronave_instalacion`). El Hobbs es el MISMO
 *    que la ficha pinta en «Horas actuales» (`AircraftService.currentHobbs`).
 *  - FECHA: aplica con `fecha_vencimiento` (fecha exacta de la etiqueta, la
 *    que MANDA) o con `limite_meses` desde `fecha_instalacion`.
 * Sin ninguna, el componente se cambia «a condición»: solo se dice cuánto
 * lleva en servicio.
 */

export const ESTADOS_VIDA = [
  'VENCIDO',
  'POR_VENCER',
  'SIN_DATOS',
  'VIGENTE',
  'SIN_LIMITE',
] as const;
export type EstadoVida = (typeof ESTADOS_VIDA)[number];
export type DimensionVida = 'HORAS' | 'FECHA';

/** Aviso por omisión (los mismos `default` de la tabla). */
export const AVISO_HORAS_DEFAULT = 10;
export const AVISO_DIAS_DEFAULT = 30;

/** Lo que el cálculo necesita de la fila (números de PostgREST: número o texto). */
export interface DatosVidaComponente {
  estado?: string | null;
  fecha_instalacion?: string | null;
  horas_aeronave_instalacion?: number | string | null;
  horas_previas?: number | string | null;
  limite_horas?: number | string | null;
  limite_meses?: number | string | null;
  fecha_vencimiento?: string | null;
  aviso_horas?: number | string | null;
  aviso_dias?: number | string | null;
  fecha_retiro?: string | null;
  horas_aeronave_retiro?: number | string | null;
}

export interface ContextoVida {
  /** Día de hoy en hora Cancún, `YYYY-MM-DD`. */
  hoy: string;
  /** Hobbs actual del avión; `null` = no se conoce (sin lecturas). */
  horasAeronave: number | null;
}

export interface VidaComponente {
  /** `horas_previas` + (Hobbs − Hobbs al instalar). `null` si falta un dato. */
  horas_en_servicio: number | null;
  /** `limite_horas` − horas en servicio. Negativo = vencido por esas horas. */
  horas_restantes: number | null;
  /** `fecha_vencimiento` o `fecha_instalacion` + `limite_meses`. */
  vence_el: string | null;
  /** `vence_el` − hoy. 0 = vence hoy; negativo = ya venció. */
  dias_restantes: number | null;
  /** hoy − `fecha_instalacion`. */
  dias_en_servicio: number | null;
  /** El PEOR de las dos dimensiones. */
  estado: EstadoVida;
  /** Qué límite decidió el estado (empate ⇒ HORAS). */
  por: DimensionVida | null;
  /** Datos que faltan para calcular (nombres de campo). */
  faltantes: string[];
}

const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_DIA = 86_400_000;

/** Número finito o `null` (vacío, texto que no es número, NaN). */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Redondeo a 2 decimales sin ruido de coma flotante (120.49999 → 120.5). */
function r2(n: number): number {
  const x = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(x, -0) ? 0 : x;
}

/** Día `YYYY-MM-DD` REAL (2026-02-30 no lo es) como epoch UTC, o `null`. */
function epochDeDia(dia: unknown): number | null {
  if (typeof dia !== 'string') return null;
  const m = RE_DIA.exec(dia.slice(0, 10));
  if (!m) return null;
  const y = Number(m[1]);
  const mes = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mes - 1, d);
  const f = new Date(t);
  if (
    f.getUTCFullYear() !== y ||
    f.getUTCMonth() !== mes - 1 ||
    f.getUTCDate() !== d
  ) {
    return null;
  }
  return t;
}

/** El día `YYYY-MM-DD` si es una fecha real; si no, `null`. */
export function diaValido(dia: unknown): string | null {
  return epochDeDia(dia) === null ? null : (dia as string).slice(0, 10);
}

function diaDeEpoch(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Días de calendario de `desde` a `hasta` (negativo si `hasta` es anterior). */
export function diasEntre(desde: string, hasta: string): number | null {
  const a = epochDeDia(desde);
  const b = epochDeDia(hasta);
  if (a === null || b === null) return null;
  return Math.round((b - a) / MS_DIA);
}

/**
 * Suma meses de calendario a un día: MISMO día del mes destino y, si ese día
 * no existe (31-ene + 1 mes), el ÚLTIMO día de ese mes (28 o 29-feb). Nunca
 * se desborda al mes siguiente. Fecha inválida o meses no enteros ⇒ `null`.
 */
export function sumarMeses(dia: string, meses: number): string | null {
  const m = RE_DIA.exec(typeof dia === 'string' ? dia.slice(0, 10) : '');
  if (!m || epochDeDia(dia) === null || !Number.isInteger(meses)) return null;
  const y = Number(m[1]);
  const mes0 = Number(m[2]) - 1 + meses;
  const d = Number(m[3]);
  const anio = y + Math.floor(mes0 / 12);
  const mesDestino = ((mes0 % 12) + 12) % 12;
  const ultimo = new Date(Date.UTC(anio, mesDestino + 1, 0)).getUTCDate();
  return diaDeEpoch(Date.UTC(anio, mesDestino, Math.min(d, ultimo)));
}

/** Gravedad: menor = más urgente (orden de la lista del avión). */
const GRAVEDAD: Record<EstadoVida, number> = {
  VENCIDO: 0,
  POR_VENCER: 1,
  SIN_DATOS: 2,
  VIGENTE: 3,
  SIN_LIMITE: 4,
};

export function gravedadDeEstado(estado: EstadoVida): number {
  return GRAVEDAD[estado];
}

/**
 * Orden de la lista de componentes INSTALADOS: por urgencia (vencido, por
 * vencer, faltan datos, vigente, sin límite) y luego por nombre.
 */
export function compararPorUrgencia(
  a: { nombre: string; vida: { estado: EstadoVida } },
  b: { nombre: string; vida: { estado: EstadoVida } },
): number {
  const g = GRAVEDAD[a.vida.estado] - GRAVEDAD[b.vida.estado];
  if (g !== 0) return g;
  return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
}

/**
 * Vida de un componente. Ver la cabecera del archivo para las reglas.
 *
 * RETIRADO: lo que estuvo en servicio queda CONGELADO al retiro (Hobbs y
 * fecha de retiro); ya no vence nada (estado SIN_LIMITE, `por` null).
 */
export function vidaDeComponente(
  c: DatosVidaComponente,
  ctx: ContextoVida,
): VidaComponente {
  const hoy = diaValido(ctx.hoy);
  const instalado = diaValido(c.fecha_instalacion);
  const hobbsInstalacion = num(c.horas_aeronave_instalacion);
  const previas = Math.max(0, num(c.horas_previas) ?? 0);
  const retirado = c.estado === 'RETIRADO';

  // ── En servicio (siempre que haya datos, haya o no límite) ──
  const hobbsFin = retirado ? num(c.horas_aeronave_retiro) : ctx.horasAeronave;
  const horasEnServicio =
    hobbsInstalacion !== null && hobbsFin !== null && Number.isFinite(hobbsFin)
      ? r2(previas + Math.max(0, hobbsFin - hobbsInstalacion))
      : null;
  const diaFin = retirado ? diaValido(c.fecha_retiro) : hoy;
  const diasServicio =
    instalado !== null && diaFin !== null ? diasEntre(instalado, diaFin) : null;
  const diasEnServicio =
    diasServicio === null ? null : Math.max(0, diasServicio);

  if (retirado) {
    return {
      horas_en_servicio: horasEnServicio,
      horas_restantes: null,
      vence_el: null,
      dias_restantes: null,
      dias_en_servicio: diasEnServicio,
      estado: 'SIN_LIMITE',
      por: null,
      faltantes: [],
    };
  }

  const faltantes: string[] = [];

  // ── Dimensión HORAS ──
  const limiteHoras = num(c.limite_horas);
  let estadoHoras: EstadoVida | null = null;
  let horasRestantes: number | null = null;
  if (limiteHoras !== null && limiteHoras > 0) {
    if (hobbsInstalacion === null) faltantes.push('horas_aeronave_instalacion');
    if (ctx.horasAeronave === null || !Number.isFinite(ctx.horasAeronave)) {
      faltantes.push('horas_aeronave');
    }
    if (horasEnServicio === null) {
      estadoHoras = 'SIN_DATOS';
    } else {
      horasRestantes = r2(limiteHoras - horasEnServicio);
      const aviso = Math.max(0, num(c.aviso_horas) ?? AVISO_HORAS_DEFAULT);
      estadoHoras =
        horasRestantes <= 0
          ? 'VENCIDO'
          : horasRestantes <= aviso
            ? 'POR_VENCER'
            : 'VIGENTE';
    }
  }

  // ── Dimensión FECHA ──
  const fechaExacta = diaValido(c.fecha_vencimiento);
  const limiteMeses = num(c.limite_meses);
  const conMeses =
    limiteMeses !== null && Number.isInteger(limiteMeses) && limiteMeses > 0;
  let estadoFecha: EstadoVida | null = null;
  let venceEl: string | null = null;
  let diasRestantes: number | null = null;
  if (fechaExacta !== null || conMeses) {
    venceEl =
      fechaExacta ??
      (instalado !== null
        ? sumarMeses(instalado, limiteMeses as number)
        : null);
    if (venceEl === null) {
      // Solo puede pasar con `limite_meses` y sin fecha de instalación.
      faltantes.push('fecha_instalacion');
      estadoFecha = 'SIN_DATOS';
    } else if (hoy === null) {
      estadoFecha = 'SIN_DATOS';
    } else {
      diasRestantes = diasEntre(hoy, venceEl);
      const aviso = Math.max(0, num(c.aviso_dias) ?? AVISO_DIAS_DEFAULT);
      estadoFecha =
        diasRestantes === null
          ? 'SIN_DATOS'
          : diasRestantes < 0
            ? 'VENCIDO'
            : diasRestantes <= aviso
              ? 'POR_VENCER'
              : 'VIGENTE';
    }
  }

  // ── Estado general: el peor; empate ⇒ HORAS ──
  let estado: EstadoVida = 'SIN_LIMITE';
  let por: DimensionVida | null = null;
  if (estadoHoras !== null) {
    estado = estadoHoras;
    por = 'HORAS';
  }
  if (
    estadoFecha !== null &&
    (estadoHoras === null || GRAVEDAD[estadoFecha] < GRAVEDAD[estadoHoras])
  ) {
    estado = estadoFecha;
    por = 'FECHA';
  }

  return {
    horas_en_servicio: horasEnServicio,
    horas_restantes: horasRestantes,
    vence_el: venceEl,
    dias_restantes: diasRestantes,
    dias_en_servicio: diasEnServicio,
    estado,
    por,
    faltantes,
  };
}

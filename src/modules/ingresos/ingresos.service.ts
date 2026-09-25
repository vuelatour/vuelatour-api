import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { SupabaseService } from '../supabase/supabase.service';
import { FlightsService } from '../flights/flights.service';
import { ConciliacionService } from '../conciliacion/conciliacion.service';
import { TipoCambioService } from '../tipo-cambio/tipo-cambio.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import type { CreateCobroDto } from '../flights/dto/cobros.dto';
import {
  LIMITE_ARCHIVO_FACTURA_BYTES,
  type ArchivoMultipart,
} from '../flights/factura-cliente.util';
import { validarComprobanteCobro } from '../flights/comprobante-cobro.util';
import { Rol, type AuthenticatedUser } from '../../common/types/auth.types';
import {
  categoriaIngresoAdmiteVuelo,
  categoriaIngresoExigeCliente,
  categoriaIngresoSumaAResultados,
  esAnticipo,
  esCategoriaIngreso,
  etiquetaCategoriaIngreso,
  etiquetaIngreso,
  type CategoriaIngreso,
} from '../../common/categoria-ingreso.util';
import {
  errorIngresosNoDisponibles,
  ingresosDisponibles,
} from '../../common/ingreso-disponible.util';
import {
  conciliacionDeCobro,
  MOV_LIGA_COLS_CON_INGRESO,
  type MovimientoLiga,
  type ViaConciliacion,
} from '../../common/cobro-conciliado.util';
import {
  etiquetaMetodoCobro,
  METODOS_COBRO_ABONO_MANUAL,
} from '../../common/metodo-cobro.util';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';
import { normalizarTc } from '../../common/tc.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { clientRequestIdEnUso } from '../../common/client-request-id.util';
import {
  CODE_CONFLICTO_VERSION,
  mismaVersion,
  ventanaCas,
} from '../../common/version-cas.util';
import { fmtDineroTexto } from '../../common/dinero-texto.util';
import { posibleDuplicado } from '../conciliacion/abono-cruce.util';
import { primeraLinea, ventanaDias } from '../conciliacion/auto-cruce.util';
import {
  coincideBusqueda,
  comisionDeAplicacion,
  estadoConciliacionCobro,
  estadoConciliacionIngreso,
  montoCuadraIngreso,
  netoIngreso,
  r2,
  saldoAnticipo,
  textoCampoBitacora,
  TOLERANCIA_INGRESO,
  vueloPorVolar,
} from './ingresos.util';
import { nombreArchivoIngresos, payloadExcelIngresos } from './ingresos-xlsx';
import {
  CrearIngresoDto,
  EditarIngresoDto,
  type AplicarAnticipoDto,
  type CobroDesdeAbonoDto,
  type EntradasQuery,
  type ExportIngresosQuery,
  type FiltrosEntradasQuery,
  type ListIngresosQuery,
  type ResumenIngresosQuery,
  type VuelosCandidatosIngresoQuery,
} from './dto/ingresos.dto';
import type {
  CuentaResumen,
  EntradaDinero,
  EstadoConciliacionEntrada,
  Ingreso,
  IngresoAplicacion,
  IngresoBitacoraFila,
  IngresoDetalle,
  ListaEntradas,
  ListaIngresos,
  MetodoIngreso,
  MonedaIngreso,
  ResumenIngresos,
  ResumenIngresosMoneda,
} from './ingresos.types';

/** Bucket PRIVADO del comprobante (lo crea la migración 20260924000004). */
export const BUCKET_INGRESOS = 'ingresos';
/** Vigencia de la URL firmada del comprobante (10 min). */
export const SEGUNDOS_URL_INGRESO = 600;
/** Tope de filas de un periodo (PostgREST pagina de 1000 en 1000). */
export const TOPE_PERIODO = 5000;
const PAGINA = 1000;

/** Columnas del ingreso + embeds por la columna FK (sin ambigüedad). */
const INGRESO_SELECT =
  'id, folio, categoria, fecha, descripcion, monto, comision_monto, moneda, tc_usd_mxn, metodo, cuenta_bancaria_id, referencia, pagador, cliente_id, vuelo_id, aeronave_id, gasto_id, notas, archivo_path, archivo_nombre, archivo_subido_at, archivo_subido_por, archivos_historial, client_request_id, deleted_at, deleted_by, motivo_baja, created_at, created_by, updated_at, updated_by, cliente:cliente_id(nombre), vuelo:vuelo_id(folio), aeronave:aeronave_id(matricula), cuenta:cuenta_bancaria_id(id, alias, banco, moneda, tipo)';

/** Cobros de un periodo con lo que pinta «Todos / Cobros de vuelos». */
const COBRO_PERIODO_SELECT =
  'id, vuelo_id, monto, moneda, metodo_cobro, comision_banco_monto, fecha_cobro, referencia, notas, registrado_por, created_at, cobro_grupo_id, ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio, estado, fecha_vuelo, cliente:cliente_id(nombre)), sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio))';

/** Quién hace la operación. */
export type ActorIngreso = Pick<AuthenticatedUser, 'userId' | 'rol'> &
  Partial<AuthenticatedUser>;

type Row = Record<string, unknown>;

/** Estado normalizado de un ingreso (alta, o vigente + cambios). */
interface EstadoIngreso {
  categoria: string;
  fecha: string;
  descripcion: string;
  monto: number;
  comision_monto: number | null;
  moneda: MonedaIngreso;
  tc_usd_mxn: number | null;
  metodo: string;
  cuenta_bancaria_id: string | null;
  referencia: string | null;
  pagador: string | null;
  cliente_id: string | null;
  vuelo_id: string | null;
  aeronave_id: string | null;
  gasto_id: string | null;
  notas: string | null;
}

const CAMPOS_ESTADO: ReadonlyArray<keyof EstadoIngreso> = [
  'categoria',
  'fecha',
  'descripcion',
  'monto',
  'comision_monto',
  'moneda',
  'tc_usd_mxn',
  'metodo',
  'cuenta_bancaria_id',
  'referencia',
  'pagador',
  'cliente_id',
  'vuelo_id',
  'aeronave_id',
  'gasto_id',
  'notas',
];

/** Métodos que se registran SIN cuenta (efectivo / dólares en mano). */
const METODOS_SIN_CUENTA: ReadonlySet<string> = new Set([
  'EFECTIVO',
  'DOLARES',
]);

/**
 * 23514 de los CHECK de `ingreso` ⇒ el MISMO `code` que la validación del
 * servicio (nunca 500). Se busca por NOMBRE del constraint.
 */
const CHECK_A_CODE: ReadonlyArray<[string, string, string]> = [
  [
    'ingreso_vuelo_chk',
    'VUELO_SOLO_EN_REEMBOLSO',
    'El pago de un vuelo se registra como cobro del vuelo; aquí contaría dos veces.',
  ],
  [
    'ingreso_tc_resultado_chk',
    'TC_REQUERIDO',
    'Captura el tipo de cambio: sin él el ingreso en dólares no puede sumar en pesos en los reportes.',
  ],
  [
    'ingreso_anticipo_chk',
    'CATEGORIA_EXIGE_CLIENTE',
    'Un anticipo necesita el cliente y no lleva vuelo (si el vuelo ya existe, registra el cobro en el vuelo).',
  ],
  [
    'ingreso_destino_chk',
    'EFECTIVO_SIN_CUENTA',
    'Sin cuenta bancaria el método debe ser Efectivo o Dólares directo.',
  ],
  [
    'ingreso_gasto_chk',
    'GASTO_SOLO_EN_REEMBOLSO',
    'Solo un reembolso recibido puede ligar un gasto.',
  ],
  [
    'ingreso_monto_chk',
    'COMISION_INVALIDA',
    'El monto debe ser mayor que 0 y la comisión menor que el monto.',
  ],
  [
    'ingreso_descripcion_chk',
    'DESCRIPCION_INVALIDA',
    'El concepto debe tener entre 3 y 300 caracteres.',
  ],
  [
    'ingreso_baja_chk',
    'MOTIVO_INVALIDO',
    'El motivo de la baja debe tener entre 5 y 500 caracteres.',
  ],
];

/** Prefijos de los triggers (23514) ⇒ 409/404 con ese `code`. */
const PREFIJOS_TRIGGER: ReadonlyArray<string> = [
  'ANTICIPO_CON_APLICACIONES',
  'ANTICIPO_MONTO_MENOR_A_APLICADO',
  'INGRESO_CONCILIADO',
  'ANTICIPO_SIN_SALDO',
  'ANTICIPO_MONEDA_DISTINTA',
  'NO_ES_ANTICIPO',
  'INGRESO_DADO_DE_BAJA',
  'ANTICIPO_LIGA_INMUTABLE',
  'ANTICIPO_NO_EXISTE',
];

function bad(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): BadRequestException {
  return new BadRequestException({
    message,
    error: code,
    ...(details ? { details } : {}),
  });
}

function unwrapOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * Candidato del 409 `ABONO_TIENE_COBRO_CANDIDATO` con el shape EXACTO del
 * contrato (`{tipo, id, etiqueta, cliente, fecha, monto, neto}`): el
 * `vuelo_id` solo sirve para filtrar dentro del servicio.
 */
function sinVuelo<T extends { vuelo_id: string | null }>(
  c: T,
): Omit<T, 'vuelo_id'> {
  const { vuelo_id: _vuelo, ...resto } = c;
  void _vuelo;
  return resto;
}

function textoONull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function mensajeErrores(errores: ValidationError[]): string[] {
  const out: string[] = [];
  const recorrer = (es: ValidationError[]) => {
    for (const e of es) {
      for (const m of Object.values(e.constraints ?? {})) out.push(m);
      if (e.children?.length) recorrer(e.children);
    }
  };
  recorrer(errores);
  return out;
}

/** ¿Es un día de calendario REAL? ('2026-02-30' ⇒ false). */
function diaValido(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/**
 * Traduce un error de BD (o el `Error` que re-lanza `createCobro`) a la
 * excepción con `code`: prefijos de los triggers ⇒ 409 (404 si el anticipo
 * no existe), CHECK por nombre ⇒ 400. null = no es un error conocido.
 */
export function traducirErrorIngreso(err: unknown): HttpException | null {
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? ((err as { message: string }).message ?? '')
        : '';
  if (!msg) return null;
  for (const p of PREFIJOS_TRIGGER) {
    if (msg.startsWith(p) || msg.includes(`${p}:`)) {
      const texto = msg.includes(':')
        ? msg.slice(msg.indexOf(':') + 1).trim()
        : msg;
      const message = texto.charAt(0).toUpperCase() + texto.slice(1);
      if (p === 'ANTICIPO_NO_EXISTE') {
        return new NotFoundException({ message, error: 'INGRESO_NO_EXISTE' });
      }
      return new ConflictException({ message, error: p });
    }
  }
  for (const [constraint, code, message] of CHECK_A_CODE) {
    if (msg.includes(constraint)) return bad(code, message);
  }
  return null;
}

/**
 * INGRESOS (24-sep-2026, contrato §5): todo el dinero que entra y NO es un
 * cobro de vuelo (otros ingresos, anticipos de clientes, reembolsos
 * recibidos, aportaciones) + la vista unificada «Todos / Cobros de vuelos»
 * (solo lectura) + anticipos aplicados a vuelos.
 *
 * Reglas de dinero (no negociables):
 * - Cuánto se cobró de un vuelo sale SOLO de `cobro_vuelo` (`cobrosEnUsd`);
 *   aquí jamás se calcula dinero de vuelo en paralelo. Los totales son
 *   NOMINALES por moneda (nunca se convierte).
 * - Un ANTICIPO se aplica creando un cobro de vuelo NORMAL por
 *   `FlightsService.createCobro` (hereda idempotencia, COBRO_EXCEDE_SALDO,
 *   bandera `cobrado`, calendario «Pagado» y aviso) con
 *   `ingreso_anticipo_id`; el trigger de BD garantiza el saldo.
 * - Un ingreso de RESULTADO nunca es el pago de un vuelo (anti doble
 *   conteo): vuelo solo en reembolsos recibidos, y «registrar como otro
 *   ingreso» un abono que cuadra con un cobro libre exige confirmación.
 * - Sin la migración 20260924000004 todo responde 503 INGRESOS_NO_DISPONIBLE.
 */
@Injectable()
export class IngresosService {
  private readonly logger = new Logger(IngresosService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flights: FlightsService,
    private readonly conciliacion: ConciliacionService,
    private readonly tipoCambio: TipoCambioService,
    private readonly pyservices: PyservicesService,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  private async assertDisponible(): Promise<void> {
    if (!(await ingresosDisponibles(this.sb))) {
      throw errorIngresosNoDisponibles();
    }
  }

  // ======================================================================
  // LECTURAS EN LOTE (anti-cap de PostgREST)
  // ======================================================================

  /** Lectura de PERIODO paginada; > TOPE_PERIODO ⇒ 400 PERIODO_MUY_GRANDE. */
  private async leerPeriodo(
    pagina: (
      desde: number,
      hasta: number,
    ) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
    tope: number = TOPE_PERIODO,
  ): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; ; i += PAGINA) {
      const { data, error } = await pagina(i, i + PAGINA - 1);
      if (error) throw new Error(error.message);
      const lote = (data ?? []) as Row[];
      out.push(...lote);
      if (out.length > tope) {
        throw bad(
          'PERIODO_MUY_GRANDE',
          `Acota el periodo: hay más de ${tope.toLocaleString('en-US')} registros.`,
          { tope },
        );
      }
      if (lote.length < PAGINA) return out;
    }
  }

  /** `in (…)` en lotes de ≤ 200 ids. */
  private async leerPorLotes(
    ids: ReadonlyArray<string>,
    consulta: (lote: string[]) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>,
  ): Promise<Row[]> {
    const unicos = [...new Set(ids.filter(Boolean))];
    const out: Row[] = [];
    for (let i = 0; i < unicos.length; i += 200) {
      const { data, error } = await consulta(unicos.slice(i, i + 200));
      if (error) throw new Error(error.message);
      out.push(...((data ?? []) as Row[]));
    }
    return out;
  }

  /** ingreso_id ⇒ movimiento que lo concilia (id, fecha, monto). */
  private async movimientosDeIngresos(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { id: string; fecha: string; monto: number }>> {
    const out = new Map<string, { id: string; fecha: string; monto: number }>();
    const filas = await this.leerPorLotes(ids, (lote) =>
      this.sb
        .from('movimiento_bancario')
        .select('id, fecha, monto, ingreso_id')
        .in('ingreso_id', lote),
    );
    for (const m of filas) {
      if (typeof m.ingreso_id === 'string') {
        out.set(m.ingreso_id, {
          id: m.id as string,
          fecha: m.fecha as string,
          monto: r2(Number(m.monto) || 0),
        });
      }
    }
    return out;
  }

  /** anticipo_id ⇒ Σ aplicado (bruto), Σ comisión y número de aplicaciones. */
  private async aplicadoDeAnticipos(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, { aplicado: number; comision: number; n: number }>> {
    const out = new Map<
      string,
      { aplicado: number; comision: number; n: number }
    >();
    // 1 anticipo ⇒ N aplicaciones: 200 ids pueden pasar de 1000 filas y
    // PostgREST corta en silencio (el saldo saldría inflado). Cada lote se
    // PAGINA (revisión adversaria 24-sep-2026).
    const unicos = [...new Set(ids.filter(Boolean))];
    const filas: Row[] = [];
    for (let i = 0; i < unicos.length; i += 200) {
      const lote = unicos.slice(i, i + 200);
      filas.push(
        ...(await this.leerPeriodo(
          (a, b) =>
            this.sb
              .from('cobro_vuelo')
              .select('id, monto, comision_banco_monto, ingreso_anticipo_id')
              .in('ingreso_anticipo_id', lote)
              .order('id', { ascending: true })
              .range(a, b),
          Number.MAX_SAFE_INTEGER,
        )),
      );
    }
    for (const c of filas) {
      const id = c.ingreso_anticipo_id as string;
      const cur = out.get(id) ?? { aplicado: 0, comision: 0, n: 0 };
      cur.aplicado = r2(cur.aplicado + (Number(c.monto) || 0));
      cur.comision = r2(cur.comision + (Number(c.comision_banco_monto) || 0));
      cur.n += 1;
      out.set(id, cur);
    }
    return out;
  }

  /** Arma el `Ingreso` público con los mapas ya resueltos (sin consultas). */
  private armar(
    f: Row,
    movs: Map<string, { id: string; fecha: string; monto: number }>,
    aplicado: Map<string, { aplicado: number; comision: number; n: number }>,
    nombres: Map<string, string>,
  ): Ingreso {
    const id = f.id as string;
    const categoria = f.categoria as CategoriaIngreso;
    const monto = r2(Number(f.monto) || 0);
    const comision =
      f.comision_monto == null ? null : r2(Number(f.comision_monto));
    const cuentaRaw = unwrapOne(
      f.cuenta as {
        id?: string;
        alias?: string;
        banco?: string;
        moneda?: string;
        tipo?: string;
      } | null,
    );
    const cuenta: CuentaResumen | null =
      cuentaRaw && typeof cuentaRaw.id === 'string'
        ? {
            id: cuentaRaw.id,
            alias: cuentaRaw.alias ?? '',
            banco: cuentaRaw.banco ?? '',
            moneda: cuentaRaw.moneda === 'USD' ? 'USD' : 'MXN',
            tipo: cuentaRaw.tipo === 'PASARELA' ? 'PASARELA' : 'BANCO',
          }
        : null;
    const mov = movs.get(id) ?? null;
    const cliente = unwrapOne(f.cliente as { nombre?: unknown } | null);
    const vuelo = unwrapOne(f.vuelo as { folio?: unknown } | null);
    const avion = unwrapOne(f.aeronave as { matricula?: unknown } | null);
    const ap = esAnticipo(categoria)
      ? (aplicado.get(id) ?? { aplicado: 0, comision: 0, n: 0 })
      : null;
    const nombre = (uid: unknown) =>
      typeof uid === 'string' ? (nombres.get(uid) ?? null) : null;
    return {
      id,
      folio: Number(f.folio),
      etiqueta: etiquetaIngreso(Number(f.folio)),
      categoria,
      categoria_etiqueta: etiquetaCategoriaIngreso(categoria),
      suma_a_resultados: categoriaIngresoSumaAResultados(categoria),
      fecha: f.fecha as string,
      descripcion: (f.descripcion as string) ?? '',
      monto,
      comision_monto: comision,
      neto: netoIngreso(monto, comision),
      moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
      tc_usd_mxn: f.tc_usd_mxn == null ? null : Number(f.tc_usd_mxn),
      metodo: f.metodo as MetodoIngreso,
      metodo_etiqueta: etiquetaMetodoCobro(f.metodo as string),
      cuenta_bancaria_id: (f.cuenta_bancaria_id as string | null) ?? null,
      cuenta,
      referencia: (f.referencia as string | null) ?? null,
      pagador: (f.pagador as string | null) ?? null,
      cliente_id: (f.cliente_id as string | null) ?? null,
      cliente_nombre:
        typeof cliente?.nombre === 'string' ? cliente.nombre : null,
      vuelo_id: (f.vuelo_id as string | null) ?? null,
      vuelo_folio: vuelo?.folio == null ? null : Number(vuelo.folio),
      aeronave_id: (f.aeronave_id as string | null) ?? null,
      matricula: typeof avion?.matricula === 'string' ? avion.matricula : null,
      gasto_id: (f.gasto_id as string | null) ?? null,
      notas: (f.notas as string | null) ?? null,
      archivo:
        typeof f.archivo_path === 'string' && f.archivo_path
          ? {
              nombre: (f.archivo_nombre as string) ?? 'comprobante',
              subido_at: (f.archivo_subido_at as string | null) ?? null,
              subido_por_nombre: nombre(f.archivo_subido_por),
            }
          : null,
      conciliacion: {
        estado: estadoConciliacionIngreso(
          {
            cuenta_bancaria_id: (f.cuenta_bancaria_id as string | null) ?? null,
          },
          mov?.id ?? null,
        ),
        movimiento_id: mov?.id ?? null,
        movimiento_fecha: mov?.fecha ?? null,
        movimiento_monto: mov?.monto ?? null,
      },
      anticipo: ap
        ? {
            aplicado: ap.aplicado,
            saldo: saldoAnticipo(monto, ap.aplicado),
            aplicaciones_n: ap.n,
          }
        : null,
      registrado_por_nombre: nombre(f.created_by),
      created_at: f.created_at as string,
      updated_at: f.updated_at as string,
      baja:
        typeof f.deleted_at === 'string' && f.deleted_at
          ? {
              at: f.deleted_at,
              por_nombre: nombre(f.deleted_by),
              motivo: (f.motivo_baja as string) ?? '',
            }
          : null,
    };
  }

  /** Filas crudas ⇒ `Ingreso[]` (mapas en lote: ni una consulta por fila). */
  private async enriquecer(filas: Row[]): Promise<Ingreso[]> {
    if (filas.length === 0) return [];
    const ids = filas.map((f) => f.id as string);
    const anticipos = filas
      .filter((f) => esAnticipo(f.categoria as string))
      .map((f) => f.id as string);
    const [movs, aplicado, nombres] = await Promise.all([
      this.movimientosDeIngresos(ids),
      this.aplicadoDeAnticipos(anticipos),
      fetchNombresUsuarios(
        this.sb,
        filas.flatMap((f) => [
          f.created_by as string | null,
          f.deleted_by as string | null,
          f.archivo_subido_por as string | null,
        ]),
      ),
    ]);
    return filas.map((f) => this.armar(f, movs, aplicado, nombres));
  }

  /** Fila viva o de baja por id (404 INGRESO_NO_EXISTE). */
  private async leerIngreso(id: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('ingreso')
      .select(INGRESO_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese ingreso ya no existe.',
        error: 'INGRESO_NO_EXISTE',
        details: { ingreso_id: id },
      });
    }
    return data;
  }

  /** Default del periodo: mes corriente Cancún. */
  private periodo(q: ResumenIngresosQuery): { desde: string; hasta: string } {
    const hoy = hoyCancun();
    const desde = q.desde ?? `${hoy.slice(0, 7)}-01`;
    const hasta = q.hasta ?? hoy;
    if (!diaValido(desde) || !diaValido(hasta)) {
      throw bad('DATOS_INVALIDOS', 'desde/hasta deben ser fechas válidas.');
    }
    if (desde > hasta) {
      throw bad('DATOS_INVALIDOS', 'desde no puede ser posterior a hasta');
    }
    return { desde, hasta };
  }

  // ======================================================================
  // COBROS DE VUELOS (solo lectura) — la regla ÚNICA de «cobros sin banco»
  // ======================================================================

  private async cobrosDelPeriodo(desde: string, hasta: string): Promise<Row[]> {
    return this.leerPeriodo((a, b) =>
      this.sb
        .from('cobro_vuelo')
        .select(COBRO_PERIODO_SELECT)
        .gte('fecha_cobro', `${desde}T00:00:00-05:00`)
        .lte('fecha_cobro', `${hasta}T23:59:59-05:00`)
        .order('fecha_cobro', { ascending: true })
        .order('id', { ascending: true })
        .range(a, b),
    );
  }

  /**
   * cobro_id ⇒ {via, movimiento_id} con la fuente única
   * `conciliacionDeCobro` (directo, sobre o su anticipo). Tres lecturas en
   * lote (≤ 200 ids) — jamás un `.or()` gigante.
   */
  private async conciliacionDeCobros(
    cobros: Row[],
  ): Promise<Map<string, { via: ViaConciliacion; movimiento_id: string }>> {
    const out = new Map<
      string,
      { via: ViaConciliacion; movimiento_id: string }
    >();
    if (cobros.length === 0) return out;
    const cobroIds = cobros.map((c) => c.id as string);
    const sobreIds = cobros
      .map((c) => c.cobro_grupo_id)
      .filter((x): x is string => typeof x === 'string' && !!x);
    const anticipoIds = cobros
      .map((c) => c.ingreso_anticipo_id)
      .filter((x): x is string => typeof x === 'string' && !!x);
    const [porCobro, porSobre, porAnticipo] = await Promise.all([
      this.leerPorLotes(cobroIds, (lote) =>
        this.sb
          .from('movimiento_bancario')
          .select(MOV_LIGA_COLS_CON_INGRESO)
          .in('cobro_id', lote),
      ),
      this.leerPorLotes(sobreIds, (lote) =>
        this.sb
          .from('movimiento_bancario')
          .select(MOV_LIGA_COLS_CON_INGRESO)
          .in('cobro_grupo_id', lote),
      ),
      this.leerPorLotes(anticipoIds, (lote) =>
        this.sb
          .from('movimiento_bancario')
          .select(MOV_LIGA_COLS_CON_INGRESO)
          .in('ingreso_id', lote),
      ),
    ]);
    const movs = [...porCobro, ...porSobre, ...porAnticipo] as Array<
      MovimientoLiga & { ingreso_id?: unknown }
    >;
    for (const c of cobros) {
      const r = conciliacionDeCobro(
        {
          id: c.id as string,
          cobro_grupo_id: c.cobro_grupo_id,
          ingreso_anticipo_id: c.ingreso_anticipo_id,
        },
        movs,
      );
      if (r && typeof r.mov.id === 'string') {
        out.set(c.id as string, { via: r.via, movimiento_id: r.mov.id });
      }
    }
    return out;
  }

  /** anticipo_id ⇒ folio (ING-n). */
  private async foliosDeIngresos(
    ids: ReadonlyArray<string>,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const filas = await this.leerPorLotes(ids, (lote) =>
      this.sb.from('ingreso').select('id, folio').in('id', lote),
    );
    for (const f of filas) out.set(f.id as string, Number(f.folio));
    return out;
  }

  /** Cobro crudo ⇒ fila unificada `EntradaDinero`. */
  private entradaDeCobro(
    c: Row,
    conc: Map<string, { via: ViaConciliacion; movimiento_id: string }>,
    folios: Map<string, number>,
    nombres: Map<string, string>,
    hoy: string,
  ): EntradaDinero & { _creado: string } {
    const vuelo = unwrapOne(
      c.vuelo as {
        folio?: unknown;
        estado?: unknown;
        fecha_vuelo?: unknown;
        cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
      } | null,
    );
    const cliente = unwrapOne(vuelo?.cliente);
    const sobre = unwrapOne(
      c.sobre as {
        grupo?: { folio?: unknown } | { folio?: unknown }[] | null;
      } | null,
    );
    const grupoFolio = unwrapOne(sobre?.grupo)?.folio;
    const monto = r2(Number(c.monto) || 0);
    const comision =
      Number(c.comision_banco_monto) > 0
        ? r2(Number(c.comision_banco_monto))
        : null;
    const anticipo =
      typeof c.ingreso_anticipo_id === 'string' && c.ingreso_anticipo_id
        ? c.ingreso_anticipo_id
        : null;
    const k = conc.get(c.id as string) ?? null;
    const estado = estadoConciliacionCobro({
      monto,
      metodo: (c.metodo_cobro as string | null) ?? null,
      via: k?.via ?? null,
    });
    const fechaVuelo =
      typeof vuelo?.fecha_vuelo === 'string' && vuelo.fecha_vuelo
        ? diaCancun(vuelo.fecha_vuelo)
        : null;
    const folio = vuelo?.folio == null ? null : Number(vuelo.folio);
    return {
      origen: 'COBRO_VUELO',
      id: c.id as string,
      dia: diaCancun(c.fecha_cobro as string),
      etiqueta: `Vuelo #${folio ?? '?'}`,
      categoria: 'COBRO_VUELO',
      categoria_etiqueta: 'Cobro de vuelo',
      cliente_nombre:
        typeof cliente?.nombre === 'string' ? cliente.nombre : null,
      concepto:
        textoONull(c.referencia) ??
        (primeraLinea(c.notas as string | null) || null),
      monto,
      comision,
      neto: monto > 0 ? r2(monto - (comision ?? 0)) : monto,
      moneda: c.moneda === 'USD' ? 'USD' : 'MXN',
      metodo: (c.metodo_cobro as string) ?? '',
      metodo_etiqueta: etiquetaMetodoCobro(c.metodo_cobro as string | null),
      vuelo_id: (c.vuelo_id as string | null) ?? null,
      vuelo_folio: folio,
      grupo_folio: grupoFolio == null ? null : Number(grupoFolio),
      vuelo_estado: typeof vuelo?.estado === 'string' ? vuelo.estado : null,
      por_volar: vueloPorVolar(
        typeof vuelo?.estado === 'string' ? vuelo.estado : null,
        fechaVuelo,
        hoy,
      ),
      anticipo_etiqueta: anticipo
        ? etiquetaIngreso(folios.get(anticipo) ?? null)
        : null,
      cuenta_en_total: anticipo === null,
      es_reembolso: monto < 0,
      conciliacion: { estado, movimiento_id: k?.movimiento_id ?? null },
      registrado_por_nombre:
        typeof c.registrado_por === 'string'
          ? (nombres.get(c.registrado_por) ?? null)
          : null,
      _creado: (c.created_at as string) ?? '',
    };
  }

  /** Ingreso armado ⇒ fila unificada `EntradaDinero`. */
  private entradaDeIngreso(i: Ingreso): EntradaDinero & { _creado: string } {
    return {
      origen: 'INGRESO',
      id: i.id,
      dia: i.fecha,
      etiqueta: i.etiqueta,
      categoria: i.categoria,
      categoria_etiqueta: i.categoria_etiqueta,
      cliente_nombre: i.cliente_nombre ?? i.pagador,
      concepto: i.descripcion,
      monto: i.monto,
      comision: i.comision_monto,
      neto: i.neto,
      moneda: i.moneda,
      metodo: i.metodo,
      metodo_etiqueta: i.metodo_etiqueta,
      vuelo_id: i.vuelo_id,
      vuelo_folio: i.vuelo_folio,
      grupo_folio: null,
      vuelo_estado: null,
      por_volar: null,
      anticipo_etiqueta: null,
      cuenta_en_total: true,
      es_reembolso: false,
      conciliacion: {
        estado: i.conciliacion.estado,
        movimiento_id: i.conciliacion.movimiento_id,
      },
      registrado_por_nombre: i.registrado_por_nombre,
      _creado: i.created_at,
    };
  }

  /** Ingresos VIVOS con fecha en el periodo (paginado). */
  private async ingresosDelPeriodo(
    desde: string,
    hasta: string,
  ): Promise<Row[]> {
    return this.leerPeriodo((a, b) =>
      this.sb
        .from('ingreso')
        .select(INGRESO_SELECT)
        .is('deleted_at', null)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .order('fecha', { ascending: true })
        .order('folio', { ascending: true })
        .range(a, b),
    );
  }

  // ======================================================================
  // GET /v1/ingresos/resumen
  // ======================================================================

  async resumen(q: ResumenIngresosQuery): Promise<ResumenIngresos> {
    await this.assertDisponible();
    const { desde, hasta } = this.periodo(q);
    const hoy = hoyCancun();
    const [cobros, ingresosRaw, abonos, cuentas, anticiposVivos] =
      await Promise.all([
        this.cobrosDelPeriodo(desde, hasta),
        this.ingresosDelPeriodo(desde, hasta),
        this.leerPeriodo((a, b) =>
          this.sb
            .from('movimiento_bancario')
            .select('id, monto, cuenta_bancaria_id')
            .eq('tipo', 'ABONO')
            .eq('conciliado', false)
            .gte('fecha', desde)
            .lte('fecha', hasta)
            .order('id', { ascending: true })
            .range(a, b),
        ),
        this.sb.from('cuenta_bancaria').select('id, moneda'),
        // Anticipos con saldo: TODAS las fechas (el saldo no caduca).
        this.leerPeriodo((a, b) =>
          this.sb
            .from('ingreso')
            .select('id, monto, moneda')
            .is('deleted_at', null)
            .eq('categoria', 'ANTICIPO_CLIENTE')
            .order('id', { ascending: true })
            .range(a, b),
        ),
      ]);
    if (cuentas.error) throw new Error(cuentas.error.message);
    const monedaCuenta = new Map(
      ((cuentas.data ?? []) as Array<{ id: string; moneda: string }>).map(
        (c) => [c.id, c.moneda],
      ),
    );
    const [conc, ingresos, aplicadoTodos] = await Promise.all([
      this.conciliacionDeCobros(cobros),
      this.enriquecer(ingresosRaw),
      this.aplicadoDeAnticipos(anticiposVivos.map((a) => a.id as string)),
    ]);

    const vacio = (moneda: MonedaIngreso): ResumenIngresosMoneda => ({
      moneda,
      cobros_vuelo: {
        recibido: 0,
        reembolsos: 0,
        n: 0,
        conciliado: 0,
        sin_conciliar: 0,
        no_bancario: 0,
      },
      depositos_por_volar: { monto: 0, n: 0 },
      aplicado_de_anticipos: { monto: 0, n: 0 },
      otros_ingresos: {
        monto: 0,
        n: 0,
        conciliado: 0,
        sin_conciliar: 0,
        no_bancario: 0,
      },
      anticipos: {
        recibido: 0,
        aplicado: 0,
        saldo: 0,
        n: 0,
        conciliado: 0,
        sin_conciliar: 0,
        no_bancario: 0,
      },
      fuera_de_resultados: { monto: 0, n: 0 },
      total_recibido: 0,
      neto_de_reembolsos: 0,
      abonos_por_identificar: { n: 0, monto: 0 },
    });
    const porMoneda = new Map<MonedaIngreso, ResumenIngresosMoneda>();
    const de = (m: unknown): ResumenIngresosMoneda => {
      const moneda: MonedaIngreso = m === 'USD' ? 'USD' : 'MXN';
      let r = porMoneda.get(moneda);
      if (!r) {
        r = vacio(moneda);
        porMoneda.set(moneda, r);
      }
      return r;
    };
    const bucket = (
      obj: { conciliado: number; sin_conciliar: number; no_bancario: number },
      estado: EstadoConciliacionEntrada,
      monto: number,
    ) => {
      if (estado === 'CONCILIADO' || estado === 'VIA_ANTICIPO') {
        obj.conciliado = r2(obj.conciliado + monto);
      } else if (estado === 'SIN_CONCILIAR') {
        obj.sin_conciliar = r2(obj.sin_conciliar + monto);
      } else {
        obj.no_bancario = r2(obj.no_bancario + monto);
      }
    };

    // Cobros de vuelos del periodo. `recibido` excluye los aplicados de un
    // anticipo (ese dinero ya entró como anticipo: cero doble conteo). Los
    // cubos de conciliación siguen la regla ÚNICA de «cobros sin banco»
    // sobre TODOS los cobros positivos (incluidos los de anticipo), para
    // que `sin_conciliar` diga el MISMO número que Conciliación y el
    // pre-cierre.
    for (const c of cobros) {
      const r = de(c.moneda);
      const monto = r2(Number(c.monto) || 0);
      const anticipo =
        typeof c.ingreso_anticipo_id === 'string' && !!c.ingreso_anticipo_id;
      if (monto < 0) {
        r.cobros_vuelo.reembolsos = r2(
          r.cobros_vuelo.reembolsos + Math.abs(monto),
        );
        continue;
      }
      const k = conc.get(c.id as string) ?? null;
      bucket(
        r.cobros_vuelo,
        estadoConciliacionCobro({
          monto,
          metodo: (c.metodo_cobro as string | null) ?? null,
          via: k?.via ?? null,
        }),
        monto,
      );
      if (anticipo) {
        r.aplicado_de_anticipos.monto = r2(
          r.aplicado_de_anticipos.monto + monto,
        );
        r.aplicado_de_anticipos.n += 1;
        continue;
      }
      r.cobros_vuelo.recibido = r2(r.cobros_vuelo.recibido + monto);
      r.cobros_vuelo.n += 1;
      const vuelo = unwrapOne(
        c.vuelo as { estado?: unknown; fecha_vuelo?: unknown } | null,
      );
      const fechaVuelo =
        typeof vuelo?.fecha_vuelo === 'string' && vuelo.fecha_vuelo
          ? diaCancun(vuelo.fecha_vuelo)
          : null;
      if (
        vueloPorVolar(
          typeof vuelo?.estado === 'string' ? vuelo.estado : null,
          fechaVuelo,
          hoy,
        )
      ) {
        r.depositos_por_volar.monto = r2(r.depositos_por_volar.monto + monto);
        r.depositos_por_volar.n += 1;
      }
    }

    // Ingresos registrados del periodo.
    for (const i of ingresos) {
      const r = de(i.moneda);
      if (categoriaIngresoSumaAResultados(i.categoria)) {
        r.otros_ingresos.monto = r2(r.otros_ingresos.monto + i.monto);
        r.otros_ingresos.n += 1;
        bucket(r.otros_ingresos, i.conciliacion.estado, i.monto);
      } else if (esAnticipo(i.categoria)) {
        r.anticipos.recibido = r2(r.anticipos.recibido + i.monto);
        r.anticipos.aplicado = r2(
          r.anticipos.aplicado + (i.anticipo?.aplicado ?? 0),
        );
        r.anticipos.saldo = r2(
          r.anticipos.saldo + (i.anticipo?.saldo ?? i.monto),
        );
        r.anticipos.n += 1;
        bucket(r.anticipos, i.conciliacion.estado, i.monto);
      } else {
        r.fuera_de_resultados.monto = r2(r.fuera_de_resultados.monto + i.monto);
        r.fuera_de_resultados.n += 1;
      }
    }

    // Abonos del banco sin identificar del periodo (moneda de su cuenta).
    for (const a of abonos) {
      const mon = monedaCuenta.get(a.cuenta_bancaria_id as string);
      if (!mon) continue;
      const r = de(mon);
      r.abonos_por_identificar.n += 1;
      r.abonos_por_identificar.monto = r2(
        r.abonos_por_identificar.monto + (Number(a.monto) || 0),
      );
    }

    for (const r of porMoneda.values()) {
      r.total_recibido = r2(
        r.cobros_vuelo.recibido +
          r.otros_ingresos.monto +
          r.anticipos.recibido +
          r.fuera_de_resultados.monto,
      );
      r.neto_de_reembolsos = r2(r.total_recibido - r.cobros_vuelo.reembolsos);
    }

    // Anticipos con saldo por aplicar, de CUALQUIER fecha.
    const conSaldo = new Map<MonedaIngreso, { saldo: number; n: number }>();
    for (const a of anticiposVivos) {
      const ap = aplicadoTodos.get(a.id as string)?.aplicado ?? 0;
      const saldo = saldoAnticipo(Number(a.monto) || 0, ap);
      if (!(saldo > 0.005)) continue;
      const moneda: MonedaIngreso = a.moneda === 'USD' ? 'USD' : 'MXN';
      const cur = conSaldo.get(moneda) ?? { saldo: 0, n: 0 };
      cur.saldo = r2(cur.saldo + saldo);
      cur.n += 1;
      conSaldo.set(moneda, cur);
    }

    const orden: MonedaIngreso[] = ['MXN', 'USD'];
    return {
      desde,
      hasta,
      por_moneda: orden
        .filter((m) => porMoneda.has(m))
        .map((m) => porMoneda.get(m)!),
      anticipos_con_saldo: orden
        .filter((m) => conSaldo.has(m))
        .map((m) => ({ moneda: m, ...conSaldo.get(m)! })),
    };
  }

  // ======================================================================
  // GET /v1/ingresos/entradas  (cobros de vuelos + ingresos, solo lectura)
  // ======================================================================

  /** Universo filtrado (sin paginar): lo comparten la lista y el Excel. */
  private async entradasFiltradas(
    q: FiltrosEntradasQuery,
  ): Promise<{ desde: string; hasta: string; filas: EntradaDinero[] }> {
    const { desde, hasta } = this.periodo(q);
    const hoy = hoyCancun();
    const origen = q.origen ?? 'todos';
    const soloCobros =
      origen === 'cobros' ||
      q.categoria === 'COBRO_VUELO' ||
      q.vuelo === 'por_volar';
    const soloIngresos =
      origen === 'ingresos' ||
      (q.categoria != null && q.categoria !== 'COBRO_VUELO');
    const [cobros, ingresosRaw] = await Promise.all([
      soloIngresos
        ? Promise.resolve([] as Row[])
        : this.cobrosDelPeriodo(desde, hasta),
      soloCobros
        ? Promise.resolve([] as Row[])
        : this.ingresosDelPeriodo(desde, hasta),
    ]);
    const anticipoIds = cobros
      .map((c) => c.ingreso_anticipo_id)
      .filter((x): x is string => typeof x === 'string' && !!x);
    const [conc, folios, nombres, ingresos] = await Promise.all([
      this.conciliacionDeCobros(cobros),
      this.foliosDeIngresos(anticipoIds),
      fetchNombresUsuarios(
        this.sb,
        cobros.map((c) => c.registrado_por as string | null),
      ),
      this.enriquecer(ingresosRaw),
    ]);
    let filas: Array<EntradaDinero & { _creado: string }> = [
      ...cobros.map((c) => this.entradaDeCobro(c, conc, folios, nombres, hoy)),
      ...ingresos.map((i) => this.entradaDeIngreso(i)),
    ];
    if (q.moneda) filas = filas.filter((e) => e.moneda === q.moneda);
    if (q.metodo) filas = filas.filter((e) => e.metodo === q.metodo);
    if (q.categoria) filas = filas.filter((e) => e.categoria === q.categoria);
    if (q.vuelo === 'por_volar')
      filas = filas.filter((e) => e.por_volar === true);
    if (q.conciliacion) {
      const quiere: Record<string, EstadoConciliacionEntrada> = {
        conciliado: 'CONCILIADO',
        sin_conciliar: 'SIN_CONCILIAR',
        no_bancario: 'NO_BANCARIO',
        via_anticipo: 'VIA_ANTICIPO',
      };
      filas = filas.filter(
        (e) => e.conciliacion.estado === quiere[q.conciliacion as string],
      );
    }
    if (q.q?.trim()) {
      const busca = q.q.trim();
      filas = filas.filter((e) =>
        coincideBusqueda(busca, [
          e.etiqueta,
          e.vuelo_folio != null ? `#${e.vuelo_folio}` : null,
          e.vuelo_folio,
          e.cliente_nombre,
          e.concepto,
          e.anticipo_etiqueta,
        ]),
      );
    }
    filas.sort(
      (a, b) =>
        (a.dia < b.dia ? 1 : a.dia > b.dia ? -1 : 0) ||
        (a._creado < b._creado ? 1 : a._creado > b._creado ? -1 : 0),
    );
    return {
      desde,
      hasta,
      filas: filas.map(({ _creado, ...e }) => {
        void _creado;
        return e;
      }),
    };
  }

  async entradas(q: EntradasQuery): Promise<ListaEntradas> {
    await this.assertDisponible();
    const { desde, hasta, filas } = await this.entradasFiltradas(q);
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return {
      data: filas.slice(offset, offset + limit),
      total: filas.length,
      limit,
      offset,
      desde,
      hasta,
    };
  }

  // ======================================================================
  // GET /v1/ingresos  (lista de ingresos registrados)
  // ======================================================================

  private async listaFiltrada(q: ListIngresosQuery): Promise<{
    desde: string;
    hasta: string;
    ingresos: Ingreso[];
  }> {
    const { desde, hasta } = this.periodo(q);
    const vista = q.vista ?? 'otros';
    const conSaldo =
      vista === 'anticipos' && (q.saldo ?? 'con_saldo') === 'con_saldo';
    const bajas = conSaldo ? 'excluir' : (q.bajas ?? 'excluir');
    const filas = await this.leerPeriodo((a, b) => {
      let qb = this.sb.from('ingreso').select(INGRESO_SELECT);
      if (vista === 'otros') qb = qb.neq('categoria', 'ANTICIPO_CLIENTE');
      if (vista === 'anticipos') qb = qb.eq('categoria', 'ANTICIPO_CLIENTE');
      // «Con saldo»: TODOS los anticipos con saldo, de cualquier fecha.
      if (!conSaldo) qb = qb.gte('fecha', desde).lte('fecha', hasta);
      if (bajas === 'excluir') qb = qb.is('deleted_at', null);
      if (bajas === 'solo') qb = qb.not('deleted_at', 'is', null);
      if (q.categoria) qb = qb.eq('categoria', q.categoria);
      if (q.moneda) qb = qb.eq('moneda', q.moneda);
      if (q.cuenta_bancaria_id)
        qb = qb.eq('cuenta_bancaria_id', q.cuenta_bancaria_id);
      if (q.cliente_id) qb = qb.eq('cliente_id', q.cliente_id);
      return qb
        .order('fecha', { ascending: false })
        .order('folio', { ascending: false })
        .range(a, b);
    });
    let ingresos = await this.enriquecer(filas);
    if (conSaldo)
      ingresos = ingresos.filter((i) => (i.anticipo?.saldo ?? 0) > 0.005);
    if (q.conciliacion) {
      const quiere = {
        conciliado: 'CONCILIADO',
        sin_conciliar: 'SIN_CONCILIAR',
        no_bancario: 'NO_BANCARIO',
      }[q.conciliacion];
      ingresos = ingresos.filter((i) => i.conciliacion.estado === quiere);
    }
    if (q.q?.trim()) {
      const busca = q.q.trim();
      ingresos = ingresos.filter((i) =>
        coincideBusqueda(busca, [
          i.etiqueta,
          i.descripcion,
          i.cliente_nombre,
          i.pagador,
          i.referencia,
          i.vuelo_folio != null ? `#${i.vuelo_folio}` : null,
        ]),
      );
    }
    return { desde, hasta, ingresos };
  }

  async lista(q: ListIngresosQuery): Promise<ListaIngresos> {
    await this.assertDisponible();
    const { desde, hasta, ingresos } = await this.listaFiltrada(q);
    const porMoneda = new Map<
      MonedaIngreso,
      { monto: number; neto: number; n: number }
    >();
    for (const i of ingresos) {
      const cur = porMoneda.get(i.moneda) ?? { monto: 0, neto: 0, n: 0 };
      cur.monto = r2(cur.monto + i.monto);
      cur.neto = r2(cur.neto + i.neto);
      cur.n += 1;
      porMoneda.set(i.moneda, cur);
    }
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return {
      data: ingresos.slice(offset, offset + limit),
      total: ingresos.length,
      limit,
      offset,
      desde,
      hasta,
      por_moneda: (['MXN', 'USD'] as MonedaIngreso[])
        .filter((m) => porMoneda.has(m))
        .map((m) => ({ moneda: m, ...porMoneda.get(m)! })),
    };
  }

  // ======================================================================
  // GET /v1/ingresos/:id
  // ======================================================================

  async obtener(id: string): Promise<IngresoDetalle> {
    await this.assertDisponible();
    const fila = await this.leerIngreso(id);
    const [ingreso] = await this.enriquecer([fila]);
    const [aplRes, movRes, bitRes] = await Promise.all([
      this.sb
        .from('cobro_vuelo')
        .select(
          'id, vuelo_id, monto, moneda, comision_banco_monto, fecha_cobro, registrado_por, created_at, vuelo:vuelo!vuelo_id(folio)',
        )
        .eq('ingreso_anticipo_id', id)
        .order('created_at', { ascending: true }),
      this.sb
        .from('movimiento_bancario')
        .select(
          'id, fecha, monto, descripcion, cuenta:cuenta_bancaria_id(alias)',
        )
        .eq('ingreso_id', id)
        .limit(1)
        .maybeSingle(),
      this.sb
        .from('ingreso_bitacora')
        .select('id, accion, actor_id, diff, nota, created_at')
        .eq('ingreso_id', id)
        .order('created_at', { ascending: false })
        .limit(100),
    ]);
    if (aplRes.error) throw new Error(aplRes.error.message);
    if (movRes.error) throw new Error(movRes.error.message);
    if (bitRes.error) throw new Error(bitRes.error.message);
    const aplicaciones = (aplRes.data ?? []) as unknown as Row[];
    const bitacora = (bitRes.data ?? []) as unknown as Row[];
    const nombres = await fetchNombresUsuarios(this.sb, [
      ...aplicaciones.map((a) => a.registrado_por as string | null),
      ...bitacora.map((b) => b.actor_id as string | null),
    ]);
    const mov = movRes.data as unknown as Row | null;
    return {
      ingreso,
      aplicaciones: aplicaciones.map((a) => this.aplicacionDe(a, nombres)),
      movimiento: mov
        ? {
            id: mov.id as string,
            fecha: mov.fecha as string,
            monto: r2(Number(mov.monto) || 0),
            descripcion: (mov.descripcion as string | null) ?? null,
            cuenta_alias:
              unwrapOne(mov.cuenta as { alias?: string } | null)?.alias ?? null,
          }
        : null,
      bitacora: bitacora.map((b) => this.filaBitacora(b, nombres)),
    };
  }

  private aplicacionDe(
    a: Row,
    nombres: Map<string, string>,
  ): IngresoAplicacion {
    const vuelo = unwrapOne(a.vuelo as { folio?: unknown } | null);
    return {
      cobro_id: a.id as string,
      vuelo_id: a.vuelo_id as string,
      vuelo_folio: vuelo?.folio == null ? null : Number(vuelo.folio),
      monto: r2(Number(a.monto) || 0),
      moneda: a.moneda === 'USD' ? 'USD' : 'MXN',
      comision_banco_monto:
        Number(a.comision_banco_monto) > 0
          ? r2(Number(a.comision_banco_monto))
          : null,
      fecha_cobro: a.fecha_cobro as string,
      registrado_por_nombre:
        typeof a.registrado_por === 'string'
          ? (nombres.get(a.registrado_por) ?? null)
          : null,
      created_at: a.created_at as string,
    };
  }

  private filaBitacora(
    b: Row,
    nombres: Map<string, string>,
  ): IngresoBitacoraFila {
    const diff = (b.diff ?? {}) as Record<string, unknown>;
    const cambios: IngresoBitacoraFila['cambios'] = [];
    for (const [campo, v] of Object.entries(diff)) {
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        ('antes' in v || 'despues' in v)
      ) {
        const par = v as { antes?: unknown; despues?: unknown };
        cambios.push({
          campo: textoCampoBitacora(campo),
          antes: par.antes ?? null,
          despues: par.despues ?? null,
        });
      }
    }
    return {
      id: b.id as string,
      accion: b.accion as IngresoBitacoraFila['accion'],
      actor_nombre:
        typeof b.actor_id === 'string'
          ? (nombres.get(b.actor_id) ?? null)
          : null,
      created_at: b.created_at as string,
      cambios,
      nota: (b.nota as string | null) ?? null,
    };
  }

  // ======================================================================
  // ALTA / EDICIÓN — validación compartida sobre el ESTADO FUSIONADO
  // ======================================================================

  /** Parsea y valida el JSON del campo `datos` (400 legible). */
  private async parsearDatos<T extends object>(
    cls: new () => T,
    datosJson: string,
  ): Promise<{ dto: T; crudo: Record<string, unknown> }> {
    let raw: unknown;
    try {
      raw = JSON.parse(datosJson);
    } catch {
      throw bad('DATOS_INVALIDOS', 'El JSON del ingreso no se pudo leer', {
        errores: ['El JSON del ingreso no se pudo leer'],
      });
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw bad('DATOS_INVALIDOS', 'El JSON del ingreso no se pudo leer', {
        errores: ['Se esperaba un objeto con los datos del ingreso'],
      });
    }
    const crudo = { ...(raw as Record<string, unknown>) };
    const dto = plainToInstance(cls, crudo);
    const errores = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errores.length > 0) {
      const mensajes = mensajeErrores(errores);
      throw bad(
        'DATOS_INVALIDOS',
        mensajes[0] ?? 'Datos del ingreso inválidos',
        {
          errores: mensajes,
        },
      );
    }
    return { dto, crudo };
  }

  /**
   * TODAS las reglas de alta sobre un estado (alta, o vigente + cambios):
   * textos, fecha, comisión, cliente/vuelo/gasto por categoría, cuenta y
   * moneda, existencia de las referencias que CAMBIARON y el TC de un
   * ingreso de resultado en USD (el oficial de su fecha si no viene).
   * Devuelve el estado normalizado.
   */
  private async validarEstado(
    e: EstadoIngreso,
    verificar: ReadonlySet<keyof EstadoIngreso>,
  ): Promise<{ estado: EstadoIngreso; avisos: string[] }> {
    const avisos: string[] = [];
    const s: EstadoIngreso = {
      ...e,
      descripcion: (e.descripcion ?? '').trim(),
      referencia: textoONull(e.referencia),
      pagador: textoONull(e.pagador),
      notas: textoONull(e.notas),
      comision_monto:
        e.comision_monto == null || !(Number(e.comision_monto) > 0)
          ? null
          : r2(Number(e.comision_monto)),
      tc_usd_mxn: normalizarTc(e.tc_usd_mxn),
    };
    if (!esCategoriaIngreso(s.categoria)) {
      throw bad('DATOS_INVALIDOS', 'Categoría de ingreso desconocida.');
    }
    if (s.descripcion.length < 3 || s.descripcion.length > 300) {
      throw bad(
        'DESCRIPCION_INVALIDA',
        'El concepto debe tener entre 3 y 300 caracteres.',
      );
    }
    if (s.referencia && s.referencia.length > 120) {
      throw bad(
        'DATOS_INVALIDOS',
        'La referencia no puede pasar de 120 caracteres.',
      );
    }
    if (s.pagador && s.pagador.length > 200) {
      throw bad(
        'DATOS_INVALIDOS',
        '«Quién pagó» no puede pasar de 200 caracteres.',
      );
    }
    if (s.notas && s.notas.length > 1000) {
      throw bad(
        'DATOS_INVALIDOS',
        'Las notas no pueden pasar de 1,000 caracteres.',
      );
    }
    if (!diaValido(s.fecha)) {
      throw bad('DATOS_INVALIDOS', 'La fecha no es válida.');
    }
    if (s.fecha > hoyCancun()) {
      throw bad('FECHA_FUTURA', 'La fecha no puede ser futura.');
    }
    if (!(s.monto > 0) || s.monto > 99_999_999.99) {
      throw bad('DATOS_INVALIDOS', 'El monto debe ser mayor que 0.');
    }
    if (s.comision_monto != null && s.comision_monto >= s.monto) {
      throw bad(
        'COMISION_INVALIDA',
        'La comisión debe ser menor que el monto.',
      );
    }
    if (categoriaIngresoExigeCliente(s.categoria) && !s.cliente_id) {
      throw bad('CATEGORIA_EXIGE_CLIENTE', 'Un anticipo necesita el cliente.');
    }
    if (esAnticipo(s.categoria) && s.vuelo_id) {
      throw bad(
        'ANTICIPO_CON_VUELO',
        'Si el vuelo ya existe, registra el cobro en el vuelo (Vuelos → Cobros).',
      );
    }
    if (s.vuelo_id && !categoriaIngresoAdmiteVuelo(s.categoria)) {
      throw bad(
        'VUELO_SOLO_EN_REEMBOLSO',
        'El pago de un vuelo se registra como cobro del vuelo; aquí contaría dos veces.',
      );
    }
    if (s.gasto_id && s.categoria !== 'REEMBOLSO_DEVOLUCION') {
      throw bad(
        'GASTO_SOLO_EN_REEMBOLSO',
        'Solo un reembolso recibido puede ligar un gasto.',
      );
    }
    if (!s.cuenta_bancaria_id && !METODOS_SIN_CUENTA.has(s.metodo)) {
      throw bad(
        'EFECTIVO_SIN_CUENTA',
        'Sin cuenta bancaria el método debe ser Efectivo o Dólares directo.',
      );
    }
    if (s.cuenta_bancaria_id) {
      const { data, error } = await this.sb
        .from('cuenta_bancaria')
        .select('id, alias, moneda')
        .eq('id', s.cuenta_bancaria_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data)
        throw bad('CUENTA_NO_EXISTE', 'Esa cuenta bancaria no existe.');
      const cta = data as { alias: string; moneda: string };
      if (cta.moneda !== s.moneda) {
        throw bad(
          'MONEDA_DISTINTA_CUENTA',
          `La moneda del ingreso (${s.moneda}) no coincide con la de la cuenta «${cta.alias}» (${cta.moneda}).`,
        );
      }
    }
    const existe = async (
      tabla: string,
      id: string | null,
      code: string,
      texto: string,
    ) => {
      if (!id) return;
      const { data, error } = await this.sb
        .from(tabla)
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw bad(code, texto);
    };
    if (verificar.has('cliente_id')) {
      await existe(
        'cliente',
        s.cliente_id,
        'CLIENTE_NO_EXISTE',
        'Ese cliente no existe.',
      );
    }
    if (verificar.has('vuelo_id')) {
      await existe(
        'vuelo',
        s.vuelo_id,
        'VUELO_NO_EXISTE',
        'Ese vuelo no existe.',
      );
    }
    if (verificar.has('aeronave_id')) {
      await existe(
        'aeronave',
        s.aeronave_id,
        'AERONAVE_NO_EXISTE',
        'Ese avión no existe.',
      );
    }
    if (verificar.has('gasto_id')) {
      await existe(
        'gasto',
        s.gasto_id,
        'GASTO_NO_EXISTE',
        'Ese gasto no existe.',
      );
    }
    // TC: un ingreso de RESULTADO en USD sin TC desaparecería de los libros
    // en pesos ⇒ el oficial de SU fecha, o 400 (espejo del CHECK
    // `ingreso_tc_resultado_chk`).
    if (
      s.moneda === 'USD' &&
      categoriaIngresoSumaAResultados(s.categoria) &&
      s.tc_usd_mxn == null
    ) {
      const oficial = await this.tipoCambio.oficialDetallePara(s.fecha);
      const tc = normalizarTc(oficial?.tc);
      if (tc == null) {
        throw bad(
          'TC_REQUERIDO',
          'Captura el tipo de cambio: sin él el ingreso en dólares no puede sumar en pesos en los reportes.',
        );
      }
      s.tc_usd_mxn = tc;
      avisos.push(
        `Se usó el tipo de cambio oficial del ${oficial?.fecha_dato ?? s.fecha}: ${tc}.`,
      );
    }
    return { estado: s, avisos };
  }

  /** DTO de alta/edición ⇒ parche de `EstadoIngreso` (solo lo que vino). */
  private estadoDeDto(
    dto: Partial<CrearIngresoDto>,
    crudo: Record<string, unknown>,
  ): Partial<EstadoIngreso> {
    const out: Partial<EstadoIngreso> = {};
    const tiene = (k: string) => Object.prototype.hasOwnProperty.call(crudo, k);
    for (const k of CAMPOS_ESTADO) {
      if (!tiene(k)) continue;
      const v = (dto as Record<string, unknown>)[k];
      (out as Record<string, unknown>)[k] =
        typeof v === 'string' && v.trim() === '' && k !== 'descripcion'
          ? null
          : (v ?? null);
    }
    return out;
  }

  /** Valida el comprobante (foto JPG/PNG/WEBP o PDF, ≤ 10 MB). */
  private validarArchivo(file: ArchivoMultipart | undefined): {
    buffer: Buffer;
    nombre: string;
    extension: string;
    contentType: string;
  } | null {
    if (!file) return null;
    const buffer = file.buffer ?? Buffer.alloc(0);
    const v = validarComprobanteCobro({
      nombre: file.originalname,
      mime: file.mimetype,
      bytes: buffer.length,
    });
    if (!v.ok) {
      if (v.codigo === 'ARCHIVO_MUY_GRANDE') {
        throw new PayloadTooLargeException({
          message: v.mensaje,
          error: 'ARCHIVO_MUY_GRANDE',
          details: {
            bytes: buffer.length,
            limite_bytes: LIMITE_ARCHIVO_FACTURA_BYTES,
          },
        });
      }
      throw bad('ARCHIVO_TIPO_INVALIDO', v.mensaje);
    }
    // El bucket `ingresos` acepta JPG, PNG, WEBP y PDF (sin HEIC).
    if (!['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(v.extension)) {
      throw bad(
        'ARCHIVO_TIPO_INVALIDO',
        'El comprobante se sube como foto (JPG, PNG, WEBP) o PDF.',
      );
    }
    return {
      buffer,
      nombre: v.nombre.slice(-200),
      extension: v.extension === 'jpeg' ? 'jpg' : v.extension,
      contentType: v.contentType,
    };
  }

  /** Sube el comprobante; null si falló (el ingreso se queda sin archivo). */
  private async subirArchivo(
    ingresoId: string,
    a: { buffer: Buffer; extension: string; contentType: string },
  ): Promise<string | null> {
    const path = `ingresos/${ingresoId}/${randomUUID()}.${a.extension}`;
    try {
      const { error } = await this.sb.storage
        .from(BUCKET_INGRESOS)
        .upload(path, a.buffer, { contentType: a.contentType, upsert: false });
      if (error) {
        this.logger.warn(
          `Comprobante del ingreso ${ingresoId}: ${error.message}`,
        );
        return null;
      }
      return path;
    } catch (err) {
      this.logger.warn(
        `Comprobante del ingreso ${ingresoId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * ÚNICO `storage.remove` del módulo: lo RECIÉN subido de una operación
   * que FALLÓ. Un archivo que alguna vez quedó en una fila NUNCA se borra.
   */
  private async retirarRecienSubido(path: string | null): Promise<void> {
    if (!path) return;
    try {
      const { error } = await this.sb.storage
        .from(BUCKET_INGRESOS)
        .remove([path]);
      if (error)
        this.logger.warn(`No se pudo retirar ${path}: ${error.message}`);
    } catch (err) {
      this.logger.warn(
        `No se pudo retirar ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Movimiento del banco (abono) con todo lo que deciden los candados. */
  private async leerAbono(movId: string): Promise<Row> {
    const { data, error } = await this.sb
      .from('movimiento_bancario')
      .select(
        'id, cuenta_bancaria_id, fecha, tipo, monto, monto_bruto, comision_monto, descripcion, referencia, conciliado, gasto_id, cobro_id, cobro_grupo_id, clasificacion_id, ingreso_id',
      )
      .eq('id', movId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: 'Ese movimiento del banco ya no existe.',
        error: 'MOVIMIENTO_NO_EXISTE',
        details: { movimiento_id: movId },
      });
    }
    const m = data as unknown as Row;
    if (m.tipo !== 'ABONO') {
      throw bad(
        'SOLO_ABONOS',
        'Solo un abono (entrada de dinero) se liga a un ingreso.',
      );
    }
    if (
      m.conciliado === true ||
      m.gasto_id ||
      m.cobro_id ||
      m.cobro_grupo_id ||
      m.clasificacion_id ||
      m.ingreso_id
    ) {
      throw new ConflictException({
        message:
          'Ese movimiento ya está conciliado con otra cosa: desvincúlalo antes.',
        error: 'MOVIMIENTO_YA_LIGADO',
        details: {
          liga: m.gasto_id
            ? 'GASTO'
            : m.cobro_id
              ? 'COBRO'
              : m.cobro_grupo_id
                ? 'SOBRE'
                : m.clasificacion_id
                  ? 'CLASIFICACION'
                  : m.ingreso_id
                    ? 'INGRESO'
                    : null,
        },
      });
    }
    return m;
  }

  /**
   * Cobros de vuelo y sobres LIBRES (métodos manuales, positivos, sin sobre
   * ni anticipo, sin liga) de la moneda del abono, ±30 días Cancún, cuyo
   * neto o bruto está a ≤ 1.00 del abono — el candado anti doble conteo de
   * «registrar como otro ingreso». Con `soloVuelo` (candado de «Es el pago
   * de un vuelo»): solo los cobros de ESE vuelo, sin sobres ni recorte.
   */
  private async cobrosQueCuadranConAbono(
    abono: Row,
    moneda: string,
    soloVuelo?: string,
  ): Promise<
    Array<{
      tipo: 'COBRO_VUELO' | 'SOBRE_GRUPO';
      id: string;
      etiqueta: string;
      cliente: string | null;
      fecha: string;
      monto: number;
      neto: number;
      /** Vuelo del cobro (null en sobres de grupo). */
      vuelo_id: string | null;
    }>
  > {
    const v = ventanaDias(abono.fecha as string, 30);
    const lo = `${v.desde}T00:00:00-05:00`;
    const hi = `${v.hasta}T23:59:59-05:00`;
    let qCobros = this.sb
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, comision_banco_monto, fecha_cobro, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .is('ingreso_anticipo_id', null)
      .in('metodo_cobro', [...METODOS_COBRO_ABONO_MANUAL])
      .eq('moneda', moneda);
    // Un vuelo concreto: TODOS sus cobros libres (sin ventana de fechas: un
    // cobro capturado al reservar sigue siendo ESE pago aunque el depósito
    // llegue semanas después).
    qCobros = soloVuelo
      ? qCobros.eq('vuelo_id', soloVuelo)
      : qCobros.gte('fecha_cobro', lo).lte('fecha_cobro', hi);
    const [cobros, sobres] = await Promise.all([
      qCobros.limit(500),
      this.sb
        .from('cobro_grupo')
        .select(
          'id, monto, comision_banco_monto, fecha_cobro, grupo:vuelo_grupo!grupo_id(folio, cliente:cliente_id(nombre))',
        )
        .gt('monto', 0)
        .in('metodo_cobro', [...METODOS_COBRO_ABONO_MANUAL])
        .eq('moneda', moneda)
        .gte('fecha_cobro', lo)
        .lte('fecha_cobro', hi)
        .limit(200),
    ]);
    if (cobros.error) throw new Error(cobros.error.message);
    if (sobres.error) throw new Error(sobres.error.message);
    const abonoMonto = {
      monto: Number(abono.monto) || 0,
      monto_bruto: abono.monto_bruto == null ? null : Number(abono.monto_bruto),
    };
    const cuadra = (c: Row) =>
      montoCuadraIngreso(
        abonoMonto,
        {
          monto: Number(c.monto) || 0,
          comision_monto:
            Number(c.comision_banco_monto) > 0
              ? Number(c.comision_banco_monto)
              : null,
        },
        TOLERANCIA_INGRESO,
      ).cuadra;
    const cCuadran = ((cobros.data ?? []) as unknown as Row[]).filter(
      (c) => cuadra(c) && (!soloVuelo || c.vuelo_id === soloVuelo),
    );
    const sCuadran = soloVuelo
      ? []
      : ((sobres.data ?? []) as unknown as Row[]).filter(cuadra);
    if (cCuadran.length === 0 && sCuadran.length === 0) return [];
    const [ligC, ligS] = await Promise.all([
      this.leerPorLotes(
        cCuadran.map((c) => c.id as string),
        (lote) =>
          this.sb
            .from('movimiento_bancario')
            .select('id, cobro_id')
            .in('cobro_id', lote),
      ),
      this.leerPorLotes(
        sCuadran.map((s) => s.id as string),
        (lote) =>
          this.sb
            .from('movimiento_bancario')
            .select('id, cobro_grupo_id')
            .in('cobro_grupo_id', lote),
      ),
    ]);
    const ocupC = new Set(ligC.map((m) => m.cobro_id as string));
    const ocupS = new Set(ligS.map((m) => m.cobro_grupo_id as string));
    const nombreDe = (rel: unknown) => {
      const p = unwrapOne(
        rel as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cli = unwrapOne(p?.cliente);
      return {
        folio: p?.folio == null ? null : Number(p.folio),
        cliente: typeof cli?.nombre === 'string' ? cli.nombre : null,
      };
    };
    const neto = (c: Row) =>
      r2((Number(c.monto) || 0) - (Number(c.comision_banco_monto) || 0));
    return [
      ...cCuadran
        .filter((c) => !ocupC.has(c.id as string))
        .map((c) => {
          const n = nombreDe(c.vuelo);
          return {
            tipo: 'COBRO_VUELO' as const,
            id: c.id as string,
            etiqueta: `Cobro · vuelo #${n.folio ?? '?'}`,
            cliente: n.cliente,
            fecha: diaCancun(c.fecha_cobro as string),
            monto: r2(Number(c.monto) || 0),
            neto: neto(c),
            vuelo_id: (c.vuelo_id as string | null) ?? null,
          };
        }),
      ...sCuadran
        .filter((s) => !ocupS.has(s.id as string))
        .map((s) => {
          const n = nombreDe(s.grupo);
          return {
            tipo: 'SOBRE_GRUPO' as const,
            id: s.id as string,
            etiqueta: `Sobre G-${n.folio ?? '?'}`,
            cliente: n.cliente,
            fecha: diaCancun(s.fecha_cobro as string),
            monto: r2(Number(s.monto) || 0),
            neto: neto(s),
            vuelo_id: null,
          };
        }),
    ].slice(0, 5);
  }

  /** Ingreso ya registrado con esa llave (idempotencia), o null. */
  private async ingresoPorLlave(key: string): Promise<Row | null> {
    const { data, error } = await this.sb
      .from('ingreso')
      .select(INGRESO_SELECT)
      .eq('client_request_id', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  }

  // ======================================================================
  // POST /v1/ingresos
  // ======================================================================

  async crear(
    datosJson: string,
    archivo: ArchivoMultipart | undefined,
    actor: ActorIngreso,
  ): Promise<{
    ingreso: Ingreso;
    movimiento_id: string | null;
    avisos: string[];
    idempotente?: true;
  }> {
    await this.assertDisponible();
    const { dto } = await this.parsearDatos(CrearIngresoDto, datosJson);

    // 1) IDEMPOTENCIA PRIMERO (lección B3 de createCobro): el reintento de un
    //    alta que SÍ quedó (y quizá ya ligada) rebotaría con cualquier
    //    candado de abajo.
    if (dto.client_request_id) {
      const ya = await this.ingresoPorLlave(dto.client_request_id);
      if (ya) return this.respuestaIdempotente(ya);
    }
    // 2) ROL: conciliar con el banco = ADMIN y FACTURACION.
    const movId = dto.movimiento_bancario_id ?? null;
    if (movId && actor.rol !== Rol.ADMIN && actor.rol !== Rol.FACTURACION) {
      throw new ForbiddenException({
        message: 'Solo Administración y Facturación concilian con el banco.',
        error: 'CONCILIAR_SOLO_ADMIN_FACTURACION',
      });
    }
    // 3) VALIDACIONES (antes de subir o escribir nada).
    const archivoOk = this.validarArchivo(archivo);
    let abono: Row | null = null;
    const base: EstadoIngreso = {
      categoria: dto.categoria,
      fecha: dto.fecha,
      descripcion: dto.descripcion,
      monto: dto.monto,
      comision_monto: dto.comision_monto ?? null,
      moneda: dto.moneda,
      tc_usd_mxn: dto.tc_usd_mxn ?? null,
      metodo: dto.metodo,
      cuenta_bancaria_id: dto.cuenta_bancaria_id ?? null,
      referencia: dto.referencia ?? null,
      pagador: dto.pagador ?? null,
      cliente_id: dto.cliente_id ?? null,
      vuelo_id: dto.vuelo_id ?? null,
      aeronave_id: dto.aeronave_id ?? null,
      gasto_id: dto.gasto_id ?? null,
      notas: dto.notas ?? null,
    };
    if (movId) {
      abono = await this.leerAbono(movId);
      if (
        base.cuenta_bancaria_id &&
        base.cuenta_bancaria_id !== abono.cuenta_bancaria_id
      ) {
        throw bad(
          'INGRESO_OTRA_CUENTA',
          'La cuenta del ingreso debe ser la del abono del banco.',
          {
            cuenta_ingreso: base.cuenta_bancaria_id,
            cuenta_movimiento: abono.cuenta_bancaria_id,
          },
        );
      }
      base.cuenta_bancaria_id = abono.cuenta_bancaria_id as string;
    }
    const { estado, avisos } = await this.validarEstado(
      base,
      new Set(['cliente_id', 'vuelo_id', 'aeronave_id', 'gasto_id']),
    );
    if (abono) {
      const cuadre = montoCuadraIngreso(
        {
          monto: Number(abono.monto) || 0,
          monto_bruto:
            abono.monto_bruto == null ? null : Number(abono.monto_bruto),
        },
        { monto: estado.monto, comision_monto: estado.comision_monto },
        TOLERANCIA_INGRESO,
      );
      if (!cuadre.cuadra) {
        const netoIng = netoIngreso(estado.monto, estado.comision_monto);
        throw new ConflictException({
          message: `El abono es de ${fmtDineroTexto(Number(abono.monto) || 0, estado.moneda)} y el ingreso neto de ${fmtDineroTexto(netoIng, estado.moneda)}: corrige el monto o la comisión del ingreso.`,
          error: 'INGRESO_MONTO_DISTINTO',
          details: {
            monto_abono: r2(Number(abono.monto) || 0),
            neto_ingreso: netoIng,
            diferencia: cuadre.diferencia,
          },
        });
      }
      // (a) ANTI DOBLE CONTEO: un abono que cuadra con un cobro de vuelo
      //     LIBRE es el pago de ese vuelo, no «otro ingreso».
      if (
        (categoriaIngresoSumaAResultados(estado.categoria) ||
          esAnticipo(estado.categoria)) &&
        dto.aceptar_sin_cobro !== true
      ) {
        const candidatos = await this.cobrosQueCuadranConAbono(
          abono,
          estado.moneda,
        );
        if (candidatos.length > 0) {
          const c = candidatos[0];
          const quien =
            c.tipo === 'COBRO_VUELO'
              ? `el cobro del ${c.etiqueta.replace('Cobro · ', '')}`
              : `el pago del grupo ${c.etiqueta.replace('Sobre ', '')}`;
          throw new ConflictException({
            message: `Este abono cuadra con ${quien}${c.cliente ? ` (${c.cliente})` : ''}: vincúlalo a ese cobro. Si de verdad es otro dinero, confírmalo.`,
            error: 'ABONO_TIENE_COBRO_CANDIDATO',
            details: { candidatos: candidatos.map(sinVuelo) },
          });
        }
      }
      // (b) LÍNEA DEL BANCO REPETIDA (misma cuenta, tipo, fecha y monto).
      if (dto.aceptar_posible_duplicado !== true) {
        const { data: lineas, error: lErr } = await this.sb
          .from('movimiento_bancario')
          .select(
            'id, cuenta_bancaria_id, tipo, fecha, monto, conciliado, descripcion',
          )
          .eq('cuenta_bancaria_id', abono.cuenta_bancaria_id as string)
          .eq('tipo', 'ABONO')
          .eq('fecha', abono.fecha)
          .limit(200);
        if (lErr) throw new Error(lErr.message);
        const universo = ((lineas ?? []) as unknown as Row[]).map((l) => ({
          id: l.id as string,
          cuenta_bancaria_id: l.cuenta_bancaria_id as string,
          tipo: l.tipo as string,
          fecha: l.fecha as string,
          monto: Number(l.monto) || 0,
          conciliado: l.conciliado === true,
          descripcion: (l.descripcion as string | null) ?? null,
        }));
        const yo = {
          id: abono.id as string,
          cuenta_bancaria_id: abono.cuenta_bancaria_id as string,
          tipo: 'ABONO',
          fecha: abono.fecha as string,
          monto: Number(abono.monto) || 0,
          conciliado: false,
          descripcion: (abono.descripcion as string | null) ?? null,
        };
        const dup = posibleDuplicado(yo, universo);
        if (dup) {
          throw new ConflictException({
            message: `Esta línea parece repetida de otra del banco (${dup.fecha} · ${fmtDineroTexto(dup.monto, estado.moneda)} · ${dup.conciliado ? 'conciliada' : 'pendiente'}): confirma antes de registrarla.`,
            error: 'ABONO_POSIBLE_DUPLICADO',
            details: {
              movimiento_id: dup.id,
              conciliado: dup.conciliado,
              descripcion: dup.descripcion,
            },
          });
        }
      }
    }

    // 4) ESCRIBIR: insert → comprobante → liga (con compensación).
    const { data: insertado, error } = await this.sb
      .from('ingreso')
      .insert({
        ...estado,
        client_request_id: dto.client_request_id ?? null,
        created_by: actor.userId,
        updated_by: actor.userId,
      })
      .select(INGRESO_SELECT)
      .maybeSingle();
    if (error) {
      if (
        error.code === '23505' &&
        dto.client_request_id &&
        (error.message ?? '').includes('uq_ingreso_client_request')
      ) {
        const ya = await this.ingresoPorLlave(dto.client_request_id);
        if (ya) return this.respuestaIdempotente(ya);
      }
      const t = traducirErrorIngreso(error);
      if (t) throw t;
      if (error.code === '23503') {
        throw bad(
          'DATOS_INVALIDOS',
          'Alguna referencia (cliente, vuelo, avión, gasto o cuenta) no existe.',
        );
      }
      throw new Error(error.message);
    }
    let fila = insertado as unknown as Row;
    const id = fila.id as string;
    let pathSubido: string | null = null;
    if (archivoOk) {
      pathSubido = await this.subirArchivo(id, archivoOk);
      if (!pathSubido) {
        avisos.push(
          'El ingreso se guardó pero el comprobante NO se subió: vuelve a adjuntarlo.',
        );
      } else {
        const { data: conArchivo, error: upErr } = await this.sb
          .from('ingreso')
          .update({
            archivo_path: pathSubido,
            archivo_nombre: archivoOk.nombre,
            archivo_subido_at: new Date().toISOString(),
            archivo_subido_por: actor.userId,
            updated_by: actor.userId,
          })
          .eq('id', id)
          .select(INGRESO_SELECT)
          .maybeSingle();
        if (upErr || !conArchivo) {
          await this.retirarRecienSubido(pathSubido);
          pathSubido = null;
          avisos.push(
            'El ingreso se guardó pero el comprobante NO se subió: vuelve a adjuntarlo.',
          );
        } else {
          fila = conArchivo;
        }
      }
    }
    if (movId) {
      try {
        await this.conciliacion.linkIngreso(movId, id, actor.userId);
      } catch (err) {
        // COMPENSACIÓN: el ingreso se BORRA (la bitácora conserva la fila
        // DELETE) y el comprobante recién subido se retira.
        const { error: delErr } = await this.sb
          .from('ingreso')
          .delete()
          .eq('id', id);
        if (delErr) {
          this.logger.error(
            `Alta desde abono ${movId}: la liga falló y NO se pudo borrar el ingreso ${id}: ${delErr.message}`,
          );
        }
        await this.retirarRecienSubido(pathSubido);
        throw err;
      }
    } else if (estado.cuenta_bancaria_id) {
      // Camino inverso (no bloqueante): un abono ya importado se liga solo
      // si este ingreso es su candidato ÚNICO.
      void this.conciliacion.intentarCruzarIngreso(id, actor.userId);
    }
    const [ingreso] = await this.enriquecer([fila]);
    return { ingreso, movimiento_id: movId, avisos };
  }

  private async respuestaIdempotente(fila: Row): Promise<{
    ingreso: Ingreso;
    movimiento_id: string | null;
    avisos: string[];
    idempotente: true;
  }> {
    const [ingreso] = await this.enriquecer([fila]);
    return {
      ingreso,
      movimiento_id: ingreso.conciliacion.movimiento_id,
      avisos: [],
      idempotente: true,
    };
  }

  // ======================================================================
  // PATCH /v1/ingresos/:id
  // ======================================================================

  async editar(
    id: string,
    datosJson: string,
    archivo: ArchivoMultipart | undefined,
    actor: ActorIngreso,
  ): Promise<{ ingreso: Ingreso; avisos: string[] }> {
    await this.assertDisponible();
    const { dto, crudo } = await this.parsearDatos(EditarIngresoDto, datosJson);
    const vigente = await this.leerIngreso(id);
    if (vigente.deleted_at) {
      throw new ConflictException({
        message: `El ingreso ${etiquetaIngreso(Number(vigente.folio))} está dado de baja.`,
        error: 'INGRESO_DADO_DE_BAJA',
      });
    }
    if (
      dto.if_updated_at &&
      !mismaVersion(dto.if_updated_at, vigente.updated_at)
    ) {
      throw this.conflictoVersion(vigente, dto.if_updated_at);
    }
    const archivoOk = this.validarArchivo(archivo);
    const actual: EstadoIngreso = {
      categoria: vigente.categoria as string,
      fecha: vigente.fecha as string,
      descripcion: (vigente.descripcion as string) ?? '',
      monto: Number(vigente.monto) || 0,
      comision_monto:
        vigente.comision_monto == null ? null : Number(vigente.comision_monto),
      moneda: vigente.moneda === 'USD' ? 'USD' : 'MXN',
      tc_usd_mxn:
        vigente.tc_usd_mxn == null ? null : Number(vigente.tc_usd_mxn),
      metodo: vigente.metodo as string,
      cuenta_bancaria_id: (vigente.cuenta_bancaria_id as string | null) ?? null,
      referencia: (vigente.referencia as string | null) ?? null,
      pagador: (vigente.pagador as string | null) ?? null,
      cliente_id: (vigente.cliente_id as string | null) ?? null,
      vuelo_id: (vigente.vuelo_id as string | null) ?? null,
      aeronave_id: (vigente.aeronave_id as string | null) ?? null,
      gasto_id: (vigente.gasto_id as string | null) ?? null,
      notas: (vigente.notas as string | null) ?? null,
    };
    const cambios = this.estadoDeDto(dto, crudo);
    const fusion: EstadoIngreso = { ...actual, ...cambios };
    // ¿Qué cambió DE VERDAD? (valor nuevo vs VIGENTE, patrón
    // `cambiaDineroDelGasto`: el panel manda el formulario completo).
    const igual = (k: keyof EstadoIngreso, a: unknown, b: unknown): boolean => {
      if (k === 'monto' || k === 'comision_monto') {
        return r2(Number(a) || 0) === r2(Number(b) || 0);
      }
      if (k === 'tc_usd_mxn') {
        return (normalizarTc(a) ?? null) === (normalizarTc(b) ?? null);
      }
      if (typeof a === 'string' || typeof b === 'string') {
        return textoONull(a) === textoONull(b);
      }
      return (a ?? null) === (b ?? null);
    };
    const cambiados = new Set<keyof EstadoIngreso>(
      CAMPOS_ESTADO.filter(
        (k) => k in cambios && !igual(k, cambios[k], actual[k]),
      ),
    );
    // CANDADOS (espejo del trigger; compara contra el VIGENTE).
    const movs = await this.movimientosDeIngresos([id]);
    const mov = movs.get(id) ?? null;
    if (
      mov &&
      (
        ['monto', 'comision_monto', 'moneda', 'cuenta_bancaria_id'] as const
      ).some((k) => cambiados.has(k))
    ) {
      throw new ConflictException({
        message: `El ingreso ${etiquetaIngreso(Number(vigente.folio))} está conciliado con un abono del banco: desvincúlalo antes de cambiar su dinero o su cuenta.`,
        error: 'INGRESO_CONCILIADO',
        details: { movimiento_id: mov.id },
      });
    }
    if (esAnticipo(actual.categoria)) {
      const ap = (await this.aplicadoDeAnticipos([id])).get(id);
      if (ap && ap.n > 0) {
        if (cambiados.has('categoria') || cambiados.has('moneda')) {
          throw new ConflictException({
            message: `El anticipo ${etiquetaIngreso(Number(vigente.folio))} ya se aplicó a ${ap.n} vuelo(s): no cambia de categoría ni de moneda. Desaplícalo antes.`,
            error: 'ANTICIPO_CON_APLICACIONES',
            details: {
              aplicado: ap.aplicado,
              saldo: saldoAnticipo(actual.monto, ap.aplicado),
            },
          });
        }
        if (cambiados.has('monto') && fusion.monto < ap.aplicado - 0.005) {
          throw new ConflictException({
            message: `El anticipo ya tiene ${fmtDineroTexto(ap.aplicado, actual.moneda)} aplicados: no puede valer menos.`,
            error: 'ANTICIPO_MONTO_MENOR_A_APLICADO',
            details: {
              aplicado: ap.aplicado,
              saldo: saldoAnticipo(actual.monto, ap.aplicado),
            },
          });
        }
      }
    }
    // TODAS las reglas de alta sobre el estado FUSIONADO.
    const { estado, avisos } = await this.validarEstado(fusion, cambiados);
    const patch: Record<string, unknown> = {};
    for (const k of CAMPOS_ESTADO) {
      if (!igual(k, estado[k], actual[k])) patch[k] = estado[k];
    }
    let pathSubido: string | null = null;
    if (archivoOk) {
      pathSubido = await this.subirArchivo(id, archivoOk);
      if (!pathSubido) {
        avisos.push('El comprobante NO se subió: vuelve a adjuntarlo.');
      } else {
        patch.archivo_path = pathSubido;
        patch.archivo_nombre = archivoOk.nombre;
        patch.archivo_subido_at = new Date().toISOString();
        patch.archivo_subido_por = actor.userId;
        if (typeof vigente.archivo_path === 'string' && vigente.archivo_path) {
          patch.archivos_historial = [
            ...this.historialDe(vigente),
            this.entradaHistorial(vigente, actor.userId, 'REEMPLAZADO'),
          ];
        }
      }
    }
    if (Object.keys(patch).length === 0) {
      const [ingreso] = await this.enriquecer([vigente]);
      return { ingreso, avisos };
    }
    patch.updated_by = actor.userId;
    let qb = this.sb.from('ingreso').update(patch).eq('id', id);
    if (dto.if_updated_at) {
      const v = ventanaCas(dto.if_updated_at);
      qb = qb.gte('updated_at', v.desde).lte('updated_at', v.hasta);
    }
    const { data, error } = await qb.select(INGRESO_SELECT).maybeSingle();
    if (error) {
      await this.retirarRecienSubido(pathSubido);
      const t = traducirErrorIngreso(error);
      if (t) throw t;
      throw new Error(error.message);
    }
    if (!data) {
      await this.retirarRecienSubido(pathSubido);
      const fresca = await this.leerIngreso(id);
      throw this.conflictoVersion(fresca, dto.if_updated_at ?? '');
    }
    const fila = data as unknown as Row;
    if (
      estado.cuenta_bancaria_id &&
      !mov &&
      (
        [
          'monto',
          'comision_monto',
          'moneda',
          'cuenta_bancaria_id',
          'fecha',
        ] as const
      ).some((k) => k in patch)
    ) {
      void this.conciliacion.intentarCruzarIngreso(id, actor.userId);
    }
    const [ingreso] = await this.enriquecer([fila]);
    return { ingreso, avisos };
  }

  /** 409 CONFLICTO_VERSION con la fila viva (mismo shape que version-cas). */
  private conflictoVersion(actual: Row, enviado: string): ConflictException {
    return new ConflictException({
      message:
        'Alguien modificó este ingreso después de tu captura; se conserva la versión del servidor.',
      error: CODE_CONFLICTO_VERSION,
      details: {
        actual,
        updated_at_enviado: enviado,
        updated_at_actual: (actual.updated_at as string | null) ?? null,
      },
    });
  }

  private historialDe(f: Row): Record<string, unknown>[] {
    return Array.isArray(f.archivos_historial)
      ? (f.archivos_historial as Record<string, unknown>[])
      : [];
  }

  private entradaHistorial(
    f: Row,
    userId: string,
    accion: 'REEMPLAZADO' | 'QUITADO',
  ): Record<string, unknown> {
    return {
      path: f.archivo_path,
      nombre: f.archivo_nombre,
      subido_at: f.archivo_subido_at ?? null,
      quitado_at: new Date().toISOString(),
      quitado_por: userId,
      accion,
    };
  }

  // ======================================================================
  // BAJA y COMPROBANTE
  // ======================================================================

  async baja(id: string, motivoRaw: string | undefined, actor: ActorIngreso) {
    await this.assertDisponible();
    const motivo = (motivoRaw ?? '').trim();
    if (motivo.length < 5 || motivo.length > 500) {
      throw bad(
        'MOTIVO_INVALIDO',
        'Escribe el motivo de la baja (entre 5 y 500 caracteres).',
      );
    }
    const vigente = await this.leerIngreso(id);
    const etiqueta = etiquetaIngreso(Number(vigente.folio));
    if (vigente.deleted_at) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} ya está dado de baja.`,
        error: 'INGRESO_DADO_DE_BAJA',
      });
    }
    const mov = (await this.movimientosDeIngresos([id])).get(id);
    if (mov) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} está conciliado con un abono del banco: desvincúlalo antes de darlo de baja.`,
        error: 'INGRESO_CONCILIADO',
        details: { movimiento_id: mov.id },
      });
    }
    if (esAnticipo(vigente.categoria as string)) {
      const ap = (await this.aplicadoDeAnticipos([id])).get(id);
      if (ap && ap.n > 0) {
        throw new ConflictException({
          message: `El anticipo ${etiqueta} ya se aplicó a ${ap.n} vuelo(s): desaplícalo antes de darlo de baja.`,
          error: 'ANTICIPO_CON_APLICACIONES',
          details: {
            aplicado: ap.aplicado,
            saldo: saldoAnticipo(Number(vigente.monto) || 0, ap.aplicado),
          },
        });
      }
    }
    const { error } = await this.sb
      .from('ingreso')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: actor.userId,
        motivo_baja: motivo,
        updated_by: actor.userId,
      })
      .eq('id', id);
    if (error) {
      const t = traducirErrorIngreso(error);
      if (t) throw t;
      throw new Error(error.message);
    }
    return { ok: true as const };
  }

  async archivoUrl(id: string) {
    await this.assertDisponible();
    const f = await this.leerIngreso(id);
    if (typeof f.archivo_path !== 'string' || !f.archivo_path) {
      throw new NotFoundException({
        message: 'Este ingreso no tiene comprobante.',
        error: 'SIN_ARCHIVO',
      });
    }
    const nombre = (f.archivo_nombre as string) ?? 'comprobante';
    const { data, error } = await this.sb.storage
      .from(BUCKET_INGRESOS)
      .createSignedUrl(f.archivo_path, SEGUNDOS_URL_INGRESO, {
        download: nombre,
      });
    if (error || !data?.signedUrl) {
      throw new Error(error?.message ?? 'No se pudo firmar la URL');
    }
    return { url: data.signedUrl, nombre, expira_en_s: SEGUNDOS_URL_INGRESO };
  }

  /** Desreferencia el comprobante (el objeto se CONSERVA en el bucket). */
  async quitarArchivo(id: string, actor: ActorIngreso) {
    await this.assertDisponible();
    const f = await this.leerIngreso(id);
    if (typeof f.archivo_path !== 'string' || !f.archivo_path) {
      throw new NotFoundException({
        message: 'Este ingreso no tiene comprobante.',
        error: 'SIN_ARCHIVO',
      });
    }
    const { error } = await this.sb
      .from('ingreso')
      .update({
        archivo_path: null,
        archivo_nombre: null,
        archivo_subido_at: null,
        archivo_subido_por: null,
        archivos_historial: [
          ...this.historialDe(f),
          this.entradaHistorial(f, actor.userId, 'QUITADO'),
        ],
        updated_by: actor.userId,
      })
      .eq('id', id);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  }

  // ======================================================================
  // VUELOS CANDIDATOS (aplicar anticipo · «Es el pago de un vuelo»)
  // ======================================================================

  async vuelosCandidatos(q: VuelosCandidatosIngresoQuery) {
    await this.assertDisponible();
    const alcance = q.cliente_id ? (q.alcance ?? 'cliente') : 'todos';
    const busca = (q.q ?? '').trim();
    let qb = this.sb
      .from('vuelo')
      .select(
        'id, folio, fecha_vuelo, estado, cliente_id, monto_total_usd, tc_usd_mxn, cliente:cliente_id(nombre)',
      );
    if (alcance === 'cliente') {
      qb = qb.eq('cliente_id', q.cliente_id);
      const folio = /^#?\d+$/.test(busca)
        ? Number(busca.replace('#', ''))
        : null;
      if (folio != null) qb = qb.eq('folio', folio);
    } else {
      if (busca.length < 2) {
        throw bad(
          'BUSQUEDA_CORTA',
          'Escribe al menos 2 caracteres: el folio del vuelo o el nombre del cliente.',
        );
      }
      if (/^#?\d+$/.test(busca)) {
        qb = qb.eq('folio', Number(busca.replace('#', '')));
      } else {
        const patron = `%${busca.replace(/[%_\\,()]/g, ' ').trim()}%`;
        const { data: clientes, error: cErr } = await this.sb
          .from('cliente')
          .select('id')
          .ilike('nombre', patron)
          .limit(50);
        if (cErr) throw new Error(cErr.message);
        const ids = ((clientes ?? []) as Array<{ id: string }>).map(
          (c) => c.id,
        );
        if (ids.length === 0) return { data: [] };
        qb = qb.in('cliente_id', ids);
      }
    }
    const { data, error } = await qb
      .order('fecha_vuelo', { ascending: false, nullsFirst: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const vuelos = (data ?? []) as unknown as Row[];
    if (vuelos.length === 0) return { data: [] };
    const ids = vuelos.map((v) => v.id as string);
    const [status, escalas] = await Promise.all([
      this.flights.cobroStatus(ids),
      this.sb
        .from('escala')
        .select('vuelo_id, orden, origen_iata, destino_iata, cancelada_at')
        .in('vuelo_id', ids)
        .order('orden', { ascending: true }),
    ]);
    if (escalas.error) throw new Error(escalas.error.message);
    const rutas = new Map<string, string[]>();
    for (const e of (escalas.data ?? []) as unknown as Row[]) {
      if (e.cancelada_at != null) continue;
      const vid = e.vuelo_id as string;
      const r = rutas.get(vid) ?? [];
      if (r.length === 0) r.push((e.origen_iata as string | null) ?? '');
      r.push((e.destino_iata as string | null) ?? '');
      rutas.set(vid, r);
    }
    return {
      data: vuelos.map((v) => {
        const total =
          Number(v.monto_total_usd) > 0 ? Number(v.monto_total_usd) : null;
        const cobrado = status[v.id as string]?.total_cobrado ?? 0;
        const cliente = unwrapOne(v.cliente as { nombre?: unknown } | null);
        return {
          vuelo_id: v.id as string,
          folio: Number(v.folio),
          fecha_vuelo: (v.fecha_vuelo as string | null) ?? null,
          estado: v.estado as string,
          cliente_nombre:
            typeof cliente?.nombre === 'string' ? cliente.nombre : null,
          ruta: rutas.get(v.id as string)?.join(' → ') ?? null,
          monto_total_usd: total,
          cobrado_usd: r2(cobrado),
          saldo_usd: total != null ? Math.max(0, r2(total - cobrado)) : null,
          tc_usd_mxn: v.tc_usd_mxn == null ? null : Number(v.tc_usd_mxn),
          es_otro_cliente:
            !!q.cliente_id && (v.cliente_id as string | null) !== q.cliente_id,
        };
      }),
    };
  }

  // ======================================================================
  // ANTICIPOS: aplicar / desaplicar
  // ======================================================================

  private async estadoAnticipo(id: string, monto: number) {
    const ap = (await this.aplicadoDeAnticipos([id])).get(id) ?? {
      aplicado: 0,
      comision: 0,
      n: 0,
    };
    return { aplicado: ap.aplicado, saldo: saldoAnticipo(monto, ap.aplicado) };
  }

  async aplicar(
    id: string,
    dto: AplicarAnticipoDto,
    actor: AuthenticatedUser,
  ): Promise<{
    aplicacion: IngresoAplicacion;
    anticipo: { aplicado: number; saldo: number };
    avisos: string[];
    idempotente?: true;
  }> {
    await this.assertDisponible();
    // 0) IDEMPOTENCIA PRIMERO: en el reintento el saldo YA bajó y el
    //    candado de saldo rebotaría una aplicación que sí quedó.
    const { data: yaRaw, error: yaErr } = await this.sb
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, comision_banco_monto, fecha_cobro, registrado_por, created_at, ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio)',
      )
      .eq('client_request_id', dto.client_request_id)
      .maybeSingle();
    if (yaErr) throw new Error(yaErr.message);
    const ya = yaRaw as unknown as Row | null;
    const anticipoFila = await this.leerIngreso(id);
    if (ya) {
      if (ya.ingreso_anticipo_id !== id) {
        throw clientRequestIdEnUso('cobro', dto.client_request_id);
      }
      const nombres = await fetchNombresUsuarios(this.sb, [
        ya.registrado_por as string | null,
      ]);
      return {
        aplicacion: this.aplicacionDe(ya, nombres),
        anticipo: await this.estadoAnticipo(
          id,
          Number(anticipoFila.monto) || 0,
        ),
        avisos: [],
        idempotente: true,
      };
    }
    // 1) Anticipo vivo, saldo, vuelo y cliente.
    const etiqueta = etiquetaIngreso(Number(anticipoFila.folio));
    if (!esAnticipo(anticipoFila.categoria as string)) {
      throw new ConflictException({
        message: `El ingreso ${etiqueta} no es un anticipo de cliente.`,
        error: 'NO_ES_ANTICIPO',
      });
    }
    if (anticipoFila.deleted_at) {
      throw new ConflictException({
        message: `El anticipo ${etiqueta} está dado de baja.`,
        error: 'INGRESO_DADO_DE_BAJA',
      });
    }
    const montoAnticipo = Number(anticipoFila.monto) || 0;
    const ap = (await this.aplicadoDeAnticipos([id])).get(id) ?? {
      aplicado: 0,
      comision: 0,
      n: 0,
    };
    const saldo = saldoAnticipo(montoAnticipo, ap.aplicado);
    const moneda = anticipoFila.moneda === 'USD' ? 'USD' : 'MXN';
    if (dto.monto > saldo + 0.005) {
      throw new ConflictException({
        message: `El anticipo ${etiqueta} tiene ${fmtDineroTexto(saldo, moneda)} por aplicar: no alcanza para ${fmtDineroTexto(dto.monto, moneda)}.`,
        error: 'ANTICIPO_SIN_SALDO',
        details: { saldo, monto: dto.monto },
      });
    }
    const vuelo = await this.flights.findById(dto.vuelo_id);
    await this.flights.assertAccess(dto.vuelo_id, actor);
    const clienteVuelo = (vuelo.cliente_id as string | null) ?? null;
    const clienteAnticipo = (anticipoFila.cliente_id as string | null) ?? null;
    if (clienteVuelo !== clienteAnticipo && dto.aceptar_otro_cliente !== true) {
      const { data: cls } = await this.sb
        .from('cliente')
        .select('id, nombre')
        .in(
          'id',
          [clienteVuelo, clienteAnticipo].filter((x): x is string => !!x),
        );
      const nombre = (cid: string | null) =>
        ((cls ?? []) as Array<{ id: string; nombre: string }>).find(
          (c) => c.id === cid,
        )?.nombre ?? null;
      throw new ConflictException({
        message: `El vuelo #${String(vuelo.folio)} es de otro cliente (${nombre(clienteVuelo) ?? 'sin cliente'}) y el anticipo ${etiqueta} de ${nombre(clienteAnticipo) ?? '¿?'}: confirma para aplicarlo de todos modos.`,
        error: 'ANTICIPO_OTRO_CLIENTE',
        details: {
          cliente_anticipo: nombre(clienteAnticipo),
          cliente_vuelo: nombre(clienteVuelo),
        },
      });
    }
    // 2) El cobro NORMAL por el único camino de alta de cobros.
    const comision = comisionDeAplicacion({
      comision_anticipo:
        anticipoFila.comision_monto == null
          ? null
          : Number(anticipoFila.comision_monto),
      monto_anticipo: montoAnticipo,
      aplicado_previo: ap.aplicado,
      comision_previa: ap.comision,
      monto: dto.monto,
    });
    const notas = `Aplicado del anticipo ${etiqueta}${dto.notas?.trim() ? ` · ${dto.notas.trim()}` : ''}`;
    const dtoCobro = {
      monto: dto.monto,
      moneda,
      metodo_cobro: anticipoFila.metodo as string,
      cuenta_destino: null,
      tc_usd_mxn:
        dto.tc_usd_mxn ??
        (anticipoFila.tc_usd_mxn == null
          ? undefined
          : Number(anticipoFila.tc_usd_mxn)),
      comision_banco_monto: comision,
      referencia: (textoONull(anticipoFila.referencia) ?? etiqueta).slice(
        0,
        100,
      ),
      fecha_cobro: new Date(`${anticipoFila.fecha as string}T12:00:00-05:00`),
      notas,
      client_request_id: dto.client_request_id,
    } as unknown as CreateCobroDto;
    let cobro: Record<string, unknown>;
    try {
      cobro = await this.flights.createCobro(
        dto.vuelo_id,
        dtoCobro,
        actor.userId,
        actor.rol,
        undefined,
        { ingreso_anticipo_id: id },
      );
    } catch (err) {
      if (err instanceof HttpException) throw err;
      const t = traducirErrorIngreso(err);
      if (t) throw t;
      throw err;
    }
    // 3) Bitácora APLICAR (best-effort) — solo si no fue un replay.
    if (cobro.idempotente !== true) {
      const { error: bErr } = await this.sb.from('ingreso_bitacora').insert({
        ingreso_id: id,
        accion: 'APLICAR',
        actor_id: actor.userId,
        diff: {
          cobro_id: cobro.id,
          vuelo_id: dto.vuelo_id,
          monto: dto.monto,
          moneda,
        },
        nota: `vuelo #${String(vuelo.folio)} · ${fmtDineroTexto(dto.monto, moneda)}`,
      });
      if (bErr) {
        this.logger.warn(
          `Bitácora APLICAR del anticipo ${id}: ${bErr.message}`,
        );
      }
    }
    const nombres = await fetchNombresUsuarios(this.sb, [actor.userId]);
    return {
      aplicacion: this.aplicacionDe(
        { ...cobro, vuelo: { folio: vuelo.folio as unknown } },
        nombres,
      ),
      anticipo: await this.estadoAnticipo(id, montoAnticipo),
      avisos: [],
      ...(cobro.idempotente === true ? { idempotente: true as const } : {}),
    };
  }

  async desaplicar(id: string, cobroId: string, actor: ActorIngreso) {
    await this.assertDisponible();
    const anticipo = await this.leerIngreso(id);
    const { data, error } = await this.sb
      .from('cobro_vuelo')
      .select('id, ingreso_anticipo_id')
      .eq('id', cobroId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const cobro = data as unknown as Row | null;
    if (!cobro || cobro.ingreso_anticipo_id !== id) {
      throw new NotFoundException({
        message: 'Ese cobro no es una aplicación de este anticipo.',
        error: 'APLICACION_NO_EXISTE',
      });
    }
    // Mismos candados y `refreshCobradoFlag` que borrar un cobro; la fila
    // DESAPLICAR de la bitácora la escribe `deleteCobro` (cubre también el
    // «Desaplicar» desde el vuelo).
    await this.flights.deleteCobro(cobroId, actor.userId);
    return {
      ok: true as const,
      anticipo: await this.estadoAnticipo(id, Number(anticipo.monto) || 0),
    };
  }

  // ======================================================================
  // POST /v1/ingresos/abonos/:movId/cobro-de-vuelo
  // ======================================================================

  /**
   * «Es el pago de un vuelo que todavía no tiene su cobro registrado»: crea
   * el cobro del vuelo (createCobro: saldo, bandera cobrado, calendario,
   * aviso) y lo liga al abono (linkCobro). Si la liga falla, el cobro recién
   * creado se BORRA (compensación). Existe para que el pago de un cliente
   * jamás termine como «otro ingreso» por falta de camino.
   */
  async cobroDeVueloDesdeAbono(
    movId: string,
    dto: CobroDesdeAbonoDto,
    actor: AuthenticatedUser,
  ): Promise<{
    cobro: Record<string, unknown>;
    movimiento_id: string;
    avisos: string[];
    idempotente?: true;
  }> {
    await this.assertDisponible();
    if (actor.rol !== Rol.ADMIN && actor.rol !== Rol.FACTURACION) {
      throw new ForbiddenException({
        message: 'Solo Administración y Facturación concilian con el banco.',
        error: 'CONCILIAR_SOLO_ADMIN_FACTURACION',
      });
    }
    // 0) IDEMPOTENCIA PRIMERO.
    const { data: yaRaw, error: yaErr } = await this.sb
      .from('cobro_vuelo')
      .select('id, vuelo_id')
      .eq('client_request_id', dto.client_request_id)
      .maybeSingle();
    if (yaErr) throw new Error(yaErr.message);
    const ya = yaRaw as unknown as Row | null;
    if (ya) {
      if (ya.vuelo_id !== dto.vuelo_id) {
        throw clientRequestIdEnUso('cobro', dto.client_request_id);
      }
      const { data: liga } = await this.sb
        .from('movimiento_bancario')
        .select('id')
        .eq('cobro_id', ya.id as string)
        .maybeSingle();
      const ligadoA = (liga as { id?: string } | null)?.id ?? null;
      if (ligadoA === movId) {
        return {
          cobro: await this.cobroPublico(dto.vuelo_id, ya.id as string, ya),
          movimiento_id: movId,
          avisos: [],
          idempotente: true,
        };
      }
      if (!ligadoA) {
        // El cobro quedó pero la liga no (reintento): se liga ahora.
        await this.conciliacion.linkCobro(
          movId,
          { cobro_id: ya.id as string },
          actor.userId,
        );
        return {
          cobro: await this.cobroPublico(dto.vuelo_id, ya.id as string, ya),
          movimiento_id: movId,
          avisos: [],
          idempotente: true,
        };
      }
      throw clientRequestIdEnUso('cobro', dto.client_request_id);
    }
    // 1) El abono: libre y con cuenta.
    const abono = await this.leerAbono(movId);
    const { data: cta, error: ctaErr } = await this.sb
      .from('cuenta_bancaria')
      .select('id, moneda, tipo')
      .eq('id', abono.cuenta_bancaria_id as string)
      .maybeSingle();
    if (ctaErr) throw new Error(ctaErr.message);
    if (!cta) throw bad('CUENTA_NO_EXISTE', 'La cuenta del abono no existe.');
    const cuenta = cta as { moneda: string; tipo: string | null };
    const moneda = cuenta.moneda === 'USD' ? 'USD' : 'MXN';
    const monto = r2(
      dto.monto ??
        (abono.monto_bruto != null
          ? Number(abono.monto_bruto)
          : Number(abono.monto)),
    );
    // 0 EXPLÍCITO: sin él un PAYWISE provisionaría 8.857 % que el banco no cobró.
    const comision = r2(
      dto.comision_banco_monto ??
        (abono.comision_monto != null ? Number(abono.comision_monto) : 0),
    );
    const cuadre = montoCuadraIngreso(
      {
        monto: Number(abono.monto) || 0,
        monto_bruto:
          abono.monto_bruto == null ? null : Number(abono.monto_bruto),
      },
      { monto, comision_monto: comision > 0 ? comision : null },
      TOLERANCIA_INGRESO,
    );
    if (!cuadre.cuadra) {
      const netoCobro = netoIngreso(monto, comision > 0 ? comision : null);
      throw new ConflictException({
        message: `El abono es de ${fmtDineroTexto(Number(abono.monto) || 0, moneda)} y el cobro neto sería de ${fmtDineroTexto(netoCobro, moneda)}: corrige el monto o la comisión.`,
        error: 'INGRESO_MONTO_DISTINTO',
        details: {
          monto_abono: r2(Number(abono.monto) || 0),
          neto_ingreso: netoCobro,
          diferencia: cuadre.diferencia,
        },
      });
    }
    await this.flights.assertAccess(dto.vuelo_id, actor);
    // ANTI DOBLE CONTEO (revisión adversaria 24-sep-2026): si ESE vuelo ya
    // tiene un cobro LIBRE que cuadra con el abono (neto o bruto ±1.00), el
    // abono ES ese cobro — crear otro contaría el mismo dinero dos veces en
    // el vuelo (`cobrosEnUsd`: bandera cobrado, reparto, libros) y el cobro
    // original se quedaría para siempre en «cobros sin banco». Caso real
    // #235: 19,380 = 20,400 − 1,020. COBRO_EXCEDE_SALDO solo lo atrapa si el
    // doble rebasa el total del vuelo.
    if (dto.aceptar_sin_cobro !== true) {
      const candidatos = await this.cobrosQueCuadranConAbono(
        abono,
        moneda,
        dto.vuelo_id,
      );
      if (candidatos.length > 0) {
        const c = candidatos[0];
        throw new ConflictException({
          message: `Este abono cuadra con el cobro que ya tiene registrado el ${c.etiqueta.replace('Cobro · ', '')}${c.cliente ? ` (${c.cliente})` : ''}: vincúlalo a ese cobro en vez de registrar otro.`,
          error: 'ABONO_TIENE_COBRO_CANDIDATO',
          details: { candidatos: candidatos.map(sinVuelo) },
        });
      }
    }
    const fecha = abono.fecha as string;
    const dtoCobro = {
      monto,
      moneda,
      metodo_cobro: cuenta.tipo === 'PASARELA' ? 'PAYWISE' : 'TRANSFERENCIA',
      comision_banco_monto: comision,
      ...(dto.tc_usd_mxn != null ? { tc_usd_mxn: dto.tc_usd_mxn } : {}),
      fecha_cobro: new Date(`${fecha}T12:00:00-05:00`),
      referencia: textoONull(abono.referencia)?.slice(0, 100) ?? undefined,
      notas: `Registrado desde el banco (${fecha})${dto.notas?.trim() ? ` · ${dto.notas.trim()}` : ''}`,
      client_request_id: dto.client_request_id,
    } as unknown as CreateCobroDto;
    // 2) El cobro por el único camino de alta (hereda COBRO_EXCEDE_SALDO…).
    const creado = (await this.flights.createCobro(
      dto.vuelo_id,
      dtoCobro,
      actor.userId,
      actor.rol,
    )) as Record<string, unknown>;
    // 3) Liga con COMPENSACIÓN.
    try {
      await this.conciliacion.linkCobro(
        movId,
        { cobro_id: creado.id as string },
        actor.userId,
      );
    } catch (err) {
      try {
        await this.flights.deleteCobro(creado.id as string, actor.userId);
      } catch (delErr) {
        this.logger.error(
          `cobro-de-vuelo ${movId}: la liga falló y NO se pudo borrar el cobro ${creado.id as string}: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
        );
      }
      throw err;
    }
    return {
      cobro: await this.cobroPublico(dto.vuelo_id, creado.id as string, creado),
      movimiento_id: movId,
      avisos: [],
    };
  }

  /** El cobro tal como lo pinta la card del vuelo (CobroConSobre). */
  private async cobroPublico(
    vueloId: string,
    cobroId: string,
    respaldo: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const lista = await this.flights.listCobros(vueloId);
      return (
        (lista.find((c) => c.id === cobroId) as Record<string, unknown>) ??
        respaldo
      );
    } catch {
      return respaldo;
    }
  }

  // ======================================================================
  // GET /v1/ingresos/export.xlsx
  // ======================================================================

  async exportXlsx(
    q: ExportIngresosQuery,
  ): Promise<{ buffer: Buffer; filename: string }> {
    await this.assertDisponible();
    const { desde, hasta } = this.periodo(q);
    // `vista` decide las hojas de ingresos: otros ⇒ sin anticipos,
    // anticipos ⇒ solo anticipos, todos (default) ⇒ las dos. Los cobros de
    // vuelos siguen los filtros de «entradas».
    const vista = q.vista ?? 'todos';
    const conCobros =
      q.origen !== 'ingresos' &&
      (q.categoria == null || q.categoria === 'COBRO_VUELO');
    const conIngresos = q.origen !== 'cobros' && q.categoria !== 'COBRO_VUELO';
    const sinIngresos = {
      desde,
      hasta,
      ingresos: [] as Ingreso[],
    };
    const [resumen, entradas, ingresos, anticipos] = await Promise.all([
      this.resumen({ desde, hasta }),
      conCobros
        ? this.entradasFiltradas({ ...q, origen: 'cobros', desde, hasta })
        : Promise.resolve({ desde, hasta, filas: [] as EntradaDinero[] }),
      conIngresos && vista !== 'anticipos'
        ? this.listaFiltrada({
            desde,
            hasta,
            vista: 'otros',
            categoria:
              q.categoria && q.categoria !== 'COBRO_VUELO'
                ? q.categoria
                : undefined,
            moneda: q.moneda,
            q: q.q,
            limit: 1,
            offset: 0,
          })
        : Promise.resolve(sinIngresos),
      conIngresos && vista !== 'otros'
        ? this.listaFiltrada({
            desde,
            hasta,
            vista: 'anticipos',
            saldo: 'todos',
            moneda: q.moneda,
            q: q.q,
            limit: 1,
            offset: 0,
          })
        : Promise.resolve(sinIngresos),
    ]);
    const cobros = entradas.filas;
    const aplic = await this.leerPorLotes(
      anticipos.ingresos.map((a) => a.id),
      (lote) =>
        this.sb
          .from('cobro_vuelo')
          .select('ingreso_anticipo_id, vuelo:vuelo!vuelo_id(folio)')
          .in('ingreso_anticipo_id', lote),
    );
    const vuelosPorAnticipo = new Map<string, number[]>();
    for (const a of aplic) {
      const f = unwrapOne(a.vuelo as { folio?: unknown } | null)?.folio;
      if (f == null) continue;
      const k = a.ingreso_anticipo_id as string;
      vuelosPorAnticipo.set(k, [
        ...(vuelosPorAnticipo.get(k) ?? []),
        Number(f),
      ]);
    }
    const buffer = await this.pyservices.generateTablaXlsx(
      payloadExcelIngresos({
        desde,
        hasta,
        resumen,
        ingresos: ingresos.ingresos,
        cobros,
        anticipos: anticipos.ingresos,
        vuelosPorAnticipo,
      }),
    );
    return { buffer, filename: nombreArchivoIngresos(desde, hasta) };
  }
}

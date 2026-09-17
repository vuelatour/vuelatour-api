import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { PyservicesService } from '../pyservices/pyservices.service';
import { IaUsoService, type UsoIaPayload } from '../ia-uso/ia-uso.service';
import type { EnvVars } from '../../config/env.schema';
import { etiquetaCategoriaGasto } from '../../common/categoria-gasto.util';
import { diaCancun, hoyCancun } from '../../common/fecha-cancun.util';
import { avionDelGasto } from '../../common/participacion-aeronave.util';
import { round6 } from '../../common/tc.util';
import {
  fetchRepartos,
  type GastoRepartoFila,
} from '../../common/gasto-reparto.util';
import {
  esParteDeSobre,
  filtroLigaCobros,
  MOV_LIGA_COLS,
  type MovimientoLiga,
} from '../../common/cobro-conciliado.util';
import {
  etiquetaMetodoCobro,
  METODOS_COBRO_ABONO_AUTO,
  METODOS_COBRO_ABONO_MANUAL,
  METODOS_COBRO_PASARELA,
} from '../../common/metodo-cobro.util';
import {
  AutoMatchDto,
  ConciliacionParseDto,
  ImportarMovimientosDto,
  ListConciliacionQuery,
  PaywiseAuditoriaQuery,
  SugerirLoteDto,
  TipoMovimientoBancario,
  type ReporteConciliacionEstado,
} from './dto/conciliacion.dto';
import {
  cruzarPaywise,
  PAYWISE_VENTANA_DIAS,
  type CobroPaywise,
  type CrucePaywise,
  type MovimientoPaywise,
  type ResultadoCrucePaywise,
} from './paywise-cruce.util';
import {
  cubreGasto,
  faltanteDe,
  montoBonito,
  mensajeGastoYaCubierto,
  mensajeMonedaDistinta,
  puedeLigar,
  type MotivoNoLigar,
} from './conciliacion-parcial.util';
import {
  CLASIFICACION_TRASPASO,
  conteoVacio,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados,
  montoCasa,
  patronTraspaso,
  primeraLinea,
  sumarResultado,
  terminacionDeMovimiento,
  TOLERANCIA_CENTAVOS,
  ventanaDias,
  type CriterioCruce,
  type GastoCandidatoCruce,
  type ResultadoCruce,
} from './auto-cruce.util';

// `cobro_grupo_id` (4-sep-2026): un ABONO concilia contra un cobro de vuelo
// (`cobro_id`) O contra el SOBRE de un grupo (`cobro_grupo_id`), excluyentes.
// monto_bruto / comision_monto (9-sep-2026): solo los abonos de una cuenta
// PASARELA (Paywise) los traen; `monto` sigue siendo lo DEPOSITADO (neto).
const MOV_COLS =
  'id, cuenta_bancaria_id, fecha, tipo, monto, monto_bruto, comision_monto, descripcion, referencia, conciliado, gasto_id, cobro_id, cobro_grupo_id, clasificacion_id, origen, notas, created_at';
const MATCH_DAYS = 3;
/**
 * Columnas del gasto que necesita el auto-cruce (fuente única: el desempate
 * por tarjeta/descripción y el camino inverso leen EXACTAMENTE lo mismo).
 */
const GASTO_CRUCE_COLS =
  'id, monto, moneda, fecha_gasto, medio_pago, tarjeta_terminacion, lugar, notas, categoria, vuelo_id, proveedor:proveedor!proveedor_id(nombre)';
/**
 * Métodos de cobro que llegan al banco como ABONO y se cruzan SOLOS
 * (auto-match): misma lista para cobro_vuelo y para los sobres de grupo.
 * Fuente única `common/metodo-cobro.util` (+ PAYWISE desde 9-sep-2026).
 */
const METODOS_ABONO_AUTO = [...METODOS_COBRO_ABONO_AUTO];
/**
 * Candidatos MANUALES: + BILLPOCKET (el depósito de la terminal también
 * aparece en el estado de cuenta; el panel ya lo ofrecía a mano).
 */
const METODOS_ABONO_MANUAL = [...METODOS_COBRO_ABONO_MANUAL];
/** Tipo de cuenta_bancaria cuyos abonos traen bruto/comisión (Paywise). */
const TIPO_CUENTA_PASARELA = 'PASARELA';
/** Ventana default (±días) de candidatos manuales: la misma que usaba el panel. */
const CANDIDATOS_DIAS_DEFAULT = 60;
const CANDIDATOS_MAX = 60;
/** Embed del sobre de grupo en movimiento_bancario (lista y reporte). */
const SOBRE_EMBED =
  'cobro_grupo:cobro_grupo!cobro_grupo_id(id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre))';

/**
 * Sobre de cobro de GRUPO tal como lo expone conciliación (lista de
 * movimientos y candidatos): forma ADITIVA junto a los cobros normales.
 */
export interface SobreConciliacion {
  tipo: 'SOBRE_GRUPO';
  cobro_grupo_id: string;
  grupo_id: string;
  grupo_folio: number | null;
  grupo_nombre: string | null;
  /** BRUTO (moneda nativa). */
  monto: number;
  moneda: string;
  metodo: string;
  /** Alias de `metodo` (paridad con cobro_vuelo). */
  metodo_cobro: string;
  fecha: string;
  /** Alias de `fecha` (paridad con cobro_vuelo). */
  fecha_cobro: string;
  referencia: string | null;
  comision_banco_monto: number | null;
  /** Lo que depositó el banco: monto − comisión. */
  neto: number;
  /** Partes (aviones) en las que se partió el sobre. */
  aviones_n: number;
}

/** Cobro de vuelo candidato a conciliar un ABONO a mano. */
export interface CandidatoCobroVuelo {
  tipo: 'COBRO_VUELO';
  /** = cobro_id (lo que se manda a PATCH movimientos/:id/cobro). */
  id: string;
  cobro_id: string;
  vuelo_id: string;
  folio: number | null;
  cliente: string | null;
  fecha_cobro: string;
  monto: number;
  moneda: string;
  metodo_cobro: string;
  referencia: string | null;
  comision_banco_monto: number | null;
  neto: number;
  /** |neto − monto del abono| (0 = cuadra exacto). */
  dif_monto: number;
}

/** Sobre de grupo candidato (se manda `cobro_grupo_id` al PATCH). */
export interface CandidatoSobreGrupo extends SobreConciliacion {
  /** = cobro_grupo_id. */
  id: string;
  cliente: string | null;
  dif_monto: number;
}

export type CandidatoCobro = CandidatoCobroVuelo | CandidatoSobreGrupo;

/** Entrada de linkCobro: cobro de vuelo O sobre de grupo (excluyentes); ambos null = desvincular. */
export interface LigaCobroInput {
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
}

/**
 * Cargo del banco ligado a un gasto (pagos parciales, 14-sep-2026):
 * `monto` en POSITIVO (|monto| del movimiento) y `moneda` = la de su
 * cuenta bancaria — con ella se decide si suma contra el gasto o si es el
 * caso cruzado USD↔MXN (1 ↔ 1).
 */
export interface CargoDeGasto {
  id: string;
  fecha: string | null;
  monto: number;
  moneda: string | null;
}

function unwrapOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}
/**
 * Solo estos medios de pago tocan el banco y pueden cruzarse con un CARGO del
 * estado de cuenta (PAYWISE entró el 2-sep-2026: sus cargos también aparecen
 * en el estado de cuenta). EFECTIVO sale de caja chica (del cajón), BODEGA es
 * un cargo contable de inventario y los PERSONAL_* llegan al banco después
 * como reintegro, no como el gasto original. Cruzarlos generaba matches
 * falsos.
 */
const MEDIOS_BANCARIOS = ['TARJETA_CORP', 'TRANSFERENCIA', 'PAYWISE'];

// Compras EN DÓLARES pagadas con tarjeta: el banco carga PESOS. El cruce
// USD↔MXN solo se acepta si el TC implícito (cargo MXN ÷ gasto USD) cae en
// esta banda plausible — fuera de ella es casi seguro otro gasto. Ajustar si
// el peso se mueve de este rango.
const TC_IMPLICITO_MIN = 15;
const TC_IMPLICITO_MAX = 25;

export interface ParsedStatement {
  movimientos: Array<{
    fecha: string | null;
    descripcion: string | null;
    monto: number;
    tipo: 'CARGO' | 'ABONO';
    referencia: string | null;
    /** Paywise (aditivo): bruto/comisión/estatus por movimiento. */
    monto_bruto?: number | null;
    comision?: number | null;
    estatus?: string | null;
  }>;
  total: number;
  /** csv | excel | pdf | paywise */
  formato: string;
  notas: string;
  modelo: string | null;
  /** Consumo de tokens (solo PDF; CSV/Excel no usan IA). */
  uso_ia?: UsoIaPayload | null;
  /** Encabezados del archivo (tabular): para el mapeo manual del panel. */
  columnas?: string[];
}

export interface SugerenciaConciliacion {
  disponible: boolean;
  gasto_id_sugerido: string | null;
  confianza: number;
  razon: string;
  /**
   * ADITIVOS 15-sep-2026. `evidencias` = los hechos que la IA dice haber
   * usado («terminación 0577 == tarjeta del gasto», «monto exacto»): sin
   * evidencias la propuesta se lee con pinzas. `alternativas` = 2.ª y 3.ª
   * opción para el panel. `terminacion_detectada` la calcula el API (no la
   * IA) a partir de la referencia del banco.
   */
  evidencias?: string[];
  alternativas?: Array<{
    gasto_id: string;
    confianza: number;
    razon: string;
  }>;
  terminacion_detectada?: string | null;
  /**
   * Por qué NINGÚN candidato encaja (solo cuando `gasto_id_sugerido` es
   * null). Lo redacta pyservices y el panel lo pinta tal cual: sin él, «no
   * hay propuesta» no dice nada al operador.
   */
  motivo_sin_match?: string | null;
  /** Gastos candidatos considerados (para que el front muestre opciones). */
  candidatos: Array<{
    /** USD = compra en dólares cuyo cargo llegó en pesos (TC implícito). */
    moneda?: string;
    tc_implicito?: number | null;
    id: string;
    fecha: string | null;
    monto: number;
    proveedor: string | null;
    /** Aditivos (14-sep-2026, pagos parciales): lo ya cruzado y lo que falta. */
    monto_vinculado?: number;
    faltante?: number;
    /** Aditivos (15-sep-2026): contexto para desempatar (IA y panel). */
    medio_pago?: string | null;
    tarjeta_terminacion?: string | null;
    categoria?: string | null;
    lugar?: string | null;
    /** Primera línea de `gasto.notas` (la que describe el gasto). */
    nota?: string | null;
    matricula?: string | null;
    vuelo_folio?: number | null;
    capturado_por?: string | null;
  }>;
}

/**
 * Resultado del auto-cruce de UN movimiento (import y re-cruce hablan el
 * mismo idioma). `motivo` es el texto que el panel muestra para explicar
 * POR QUÉ un movimiento sigue pendiente — la pregunta literal del cliente.
 */
export interface ResultadoMovimiento {
  movimiento_id: string;
  resultado: ResultadoCruce;
  criterio: CriterioCruce | null;
  motivo: string | null;
  candidatos_n: number;
  gasto_id?: string | null;
  cobro_id?: string | null;
  cobro_grupo_id?: string | null;
}

/** Contexto compartido del auto-cruce (se carga UNA vez por corrida). */
interface CruceCtx {
  /** Terminaciones de `tarjeta_corporativa` activas (desempate por tarjeta). */
  terminaciones: string[];
  /** Id de la clasificación «Traspaso entre cuentas» (perezoso). */
  clasificacionTraspaso?: string | null;
}

/** Tope de filas del detalle que devuelve el re-cruce (respuesta acotada). */
const DETALLE_MAX = 300;

/** Tope de movimientos por corrida del re-cruce (evita respuestas eternas). */
const RECRUCE_MAX = 2000;

/** Banda de tolerancia de monto (±5%) para juntar gastos candidatos. */
const MATCH_MONTO_PCT = 0.05;

/**
 * Tope de gastos que lee el cálculo del «por qué sigue pendiente» de la
 * lista. Si la ventana trae MÁS que esto, la foto está incompleta y NO se
 * anota ningún motivo (un «sin candidato» falso sería peor que no decir nada).
 */
const MOTIVO_GASTOS_MAX = 4000;

@Injectable()
export class ConciliacionService {
  private readonly logger = new Logger(ConciliacionService.name);

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly supabase: SupabaseService,
    private readonly pyservices: PyservicesService,
    private readonly iaUso: IaUsoService,
  ) {}

  /** Parsea el estado de cuenta en pyservices (sin persistir). */
  async parse(
    dto: ConciliacionParseDto,
    userId?: string,
  ): Promise<ParsedStatement> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'Conciliación no configurada (pyservices).',
      );
    }
    const controller = new AbortController();
    // Un PDF con cientos de movimientos tarda varios minutos en extraerse con
    // IA: 60s abortaba a media lectura. La importación es manual (el operador
    // espera) y CSV/Excel siguen siendo instantáneos.
    const timer = setTimeout(() => controller.abort(), 270_000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify({
          filename: dto.filename,
          file_base64: dto.file_base64,
          // Mapeo manual de columnas Paywise (respaldo del panel).
          mapeo: dto.mapeo ?? null,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ServiceUnavailableException(
          `pyservices respondió ${res.status} al parsear: ${detail.slice(0, 200)}`,
        );
      }
      const body = (await res.json()) as ParsedStatement;
      // SOLO el camino PDF gasta IA (CSV/Excel son pandas): sin uso_ia no hay
      // nada que registrar.
      if (body.uso_ia) {
        this.iaUso.registrar('ESTADO_CUENTA_PDF', body.uso_ia, {
          usuarioId: userId ?? null,
          contexto: { filename: dto.filename },
        });
      }
      return body;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`parse estado de cuenta falló: ${msg}`);
      throw new ServiceUnavailableException(
        `No se pudo parsear el estado de cuenta: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Persiste los movimientos y auto-concilia los CARGO con gastos del mismo monto/fecha. */
  async importar(dto: ImportarMovimientosDto, userId: string) {
    // Compat: importación síncrona (sin progreso). El panel usa importarAsync.
    return this.ejecutarImport(dto, userId, async () => {});
  }

  /**
   * Importación como JOB del servidor: responde de inmediato con job_id y el
   * proceso (dedupe, archivo, insert y auto-conciliación) sigue en el backend
   * aunque el navegador se cierre. El panel consulta el avance con
   * importStatus (barra de porcentaje).
   */
  async importarAsync(dto: ImportarMovimientosDto, userId: string) {
    const total = dto.movimientos.filter((m) => m.fecha).length;
    if (total === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    const { data: job, error } = await this.supabase.service
      .from('conciliacion_import_job')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        total_movimientos: total,
        paso: 'Preparando importación…',
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }
    void this.correrImportJob(job!.id as string, dto, userId);
    return { job_id: job!.id as string };
  }

  private async correrImportJob(
    jobId: string,
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<void> {
    const setJob = async (
      patch: Record<string, unknown>,
      // Columnas del desglose (migración 20260916000001). Mientras no esté
      // aplicada se reintenta SIN ellas: el job nunca se queda sin cerrar
      // por una columna que todavía no existe.
      extras: Record<string, unknown> = {},
    ) => {
      const base = { ...patch, updated_at: new Date().toISOString() };
      const { error } = await this.supabase.service
        .from('conciliacion_import_job')
        .update({ ...base, ...extras })
        .eq('id', jobId);
      if (!error) return;
      if (Object.keys(extras).length > 0) {
        this.logger.warn(
          `import job ${jobId}: sin columnas de desglose (${error.message}); se guarda el resumen básico.`,
        );
        const { error: err2 } = await this.supabase.service
          .from('conciliacion_import_job')
          .update(base)
          .eq('id', jobId);
        if (err2) this.logger.warn(`import job ${jobId}: ${err2.message}`);
        return;
      }
      this.logger.warn(`import job ${jobId}: ${error.message}`);
    };
    try {
      const res = await this.ejecutarImport(
        dto,
        userId,
        async (progreso, paso) => setJob({ progreso, paso }),
      );
      await setJob(
        {
          estado: 'LISTO',
          progreso: 100,
          paso: 'Terminado',
          importados: res.importados,
          conciliados_auto: res.conciliados_auto,
          duplicados_omitidos: res.duplicados_omitidos,
        },
        {
          errores: res.errores,
          resultados: {
            conciliados: res.conciliados,
            traspasos: res.traspasos,
            ambiguos: res.ambiguos,
            sin_candidato: res.sin_candidato,
            rechazados: res.rechazados,
            errores: res.errores,
            por_criterio: res.por_criterio,
          },
          errores_detalle: res.detalle.slice(0, 100),
        },
      );
    } catch (err) {
      // El job jamás queda colgado en PROCESANDO: el error se muestra tal
      // cual en el panel para corregir (cuenta equivocada, archivo, etc.).
      await setJob({
        estado: 'ERROR',
        paso: 'Error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Estado de un job de importación (polling del panel). Expone el desglose
   * por resultado (`resultados`, `errores`, `errores_detalle`) cuando la
   * migración 20260916000001 está aplicada; si no, el mismo shape de antes.
   */
  async importStatus(jobId: string) {
    const BASE =
      'id, estado, progreso, paso, total_movimientos, importados, conciliados_auto, duplicados_omitidos, error, created_at';
    const leer = async (cols: string) =>
      this.supabase.service
        .from('conciliacion_import_job')
        .select(cols)
        .eq('id', jobId)
        .maybeSingle();
    let { data, error } = await leer(
      `${BASE}, errores, errores_detalle, resultados`,
    );
    if (error) {
      ({ data, error } = await leer(BASE));
    }
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Job ${jobId} not found`);
    // El desglose se guarda ANIDADO en `resultados` (una sola columna jsonb)
    // pero el panel —y cualquier consumidor— lo lee PLANO, igual que en la
    // respuesta de `importar`. Se devuelven las dos formas: sin esto, el
    // resumen del job salía en ceros aunque el cruce hubiera funcionado.
    const fila = data as unknown as Record<string, unknown>;
    const r = fila.resultados;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      return { ...fila, ...(r as Record<string, unknown>) };
    }
    return fila;
  }

  private async ejecutarImport(
    dto: ImportarMovimientosDto,
    userId: string,
    onProgress: (progreso: number, paso: string) => Promise<void>,
  ) {
    const base = dto.movimientos
      .filter((m) => m.fecha)
      .map((m) => ({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        fecha: m.fecha,
        tipo: m.tipo,
        monto: m.monto,
        descripcion: m.descripcion ?? null,
        referencia: m.referencia ?? null,
        // Pasarela (Paywise): bruto y comisión del movimiento; null en bancos.
        monto_bruto: m.monto_bruto != null ? r2(Number(m.monto_bruto)) : null,
        comision_monto:
          m.comision_monto != null ? r2(Number(m.comision_monto)) : null,
        origen: 'IMPORTADO',
        created_by: userId,
        updated_by: userId,
      }));
    if (base.length === 0) {
      throw new BadRequestException(
        'No hay movimientos con fecha para importar.',
      );
    }
    await onProgress(5, 'Buscando duplicados…');

    // CANDADO DE RE-IMPORTACIÓN: el mismo estado de cuenta subido dos veces
    // duplicaría los movimientos e inflaría los pendientes para siempre (los
    // gastos ya conciliados no se vuelven a cruzar). Dedup MULTICONJUNTO por
    // (fecha, tipo, monto, descripción) contra lo ya importado en la cuenta:
    // dos cargos legítimos idénticos del mismo día solo se omiten si ya
    // existen exactamente esas repeticiones en la base.
    const fechas = base.map((r) => r.fecha).sort();
    const { data: previos, error: prevErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('fecha, tipo, monto, descripcion, referencia')
      .eq('cuenta_bancaria_id', dto.cuenta_bancaria_id)
      .gte('fecha', fechas[0])
      .lte('fecha', fechas[fechas.length - 1])
      // SIN limit explícito PostgREST corta en el «Max rows» del proyecto
      // (1000) y el multiconjunto salía incompleto ⇒ duplicados en silencio.
      .limit(20000);
    if (prevErr) throw new Error(prevErr.message);
    // Fuente única del candado: `emparejarDuplicados` (auto-cruce.util). La
    // REFERENCIA manda cuando existe de los dos lados (re-subir el MISMO PDF
    // con la descripción redactada distinta por la IA ya no duplica).
    const { aInsertar: nuevos, duplicados: duplicadosOmitidos } =
      emparejarDuplicados(base, previos ?? []);

    await onProgress(18, 'Archivando el estado de cuenta…');
    // El archivo original se archiva DESPUÉS de validar y ANTES de insertar:
    // cada movimiento queda ligado a su estado de cuenta. Se archiva aunque
    // todo resulte duplicado (re-subir un estado de cuenta viejo solo para
    // conservar el archivo es un caso legítimo).
    const estadoCuentaId = await this.archivarEstadoCuenta(dto, userId);

    if (nuevos.length === 0) {
      if (estadoCuentaId) {
        await this.supabase.service
          .from('estado_cuenta_archivo')
          .update({ movimientos_importados: 0 })
          .eq('id', estadoCuentaId);
      }
      return {
        importados: 0,
        conciliados_auto: 0,
        duplicados_omitidos: duplicadosOmitidos,
        conciliados: 0,
        traspasos: 0,
        ambiguos: 0,
        sin_candidato: 0,
        rechazados: 0,
        errores: 0,
        por_criterio: {} as Record<string, number>,
        detalle: [] as ResultadoMovimiento[],
      };
    }
    const rows = nuevos.map((r) => ({
      ...r,
      estado_cuenta_id: estadoCuentaId,
    }));

    await onProgress(30, `Guardando ${rows.length} movimientos…`);
    const { data: inserted, error } = await this.supabase.service
      .from('movimiento_bancario')
      .insert(rows)
      .select(
        'id, fecha, monto, tipo, monto_bruto, comision_monto, referencia, descripcion',
      );
    if (error) {
      if (error.code === '23503')
        throw new BadRequestException('Cuenta bancaria no encontrada.');
      throw new Error(error.message);
    }

    // La moneda de la cuenta define contra qué se cruza: un cargo de 3,000 en
    // la cuenta USD jamás debe conciliar un gasto de $3,000 MXN. El TIPO
    // decide el cruce de abonos: PASARELA (Paywise) coteja bruto/neto/
    // referencia a ±5 días; BANCO, neto/bruto a ±3.
    const cuentaInfo = await this.infoCuenta(dto.cuenta_bancaria_id);
    const monedaCuenta = cuentaInfo.moneda;

    // Auto-conciliación: la parte lenta (una consulta por movimiento). El
    // progreso avanza de 35 a 95, reportado por lotes para no duplicar el
    // costo con updates del job en cada vuelta.
    //
    // RESILIENCIA (15-sep-2026): NINGÚN movimiento puede tumbar la
    // importación. El 15-sep el trigger `tg_mov_bancario_gasto_suma` lanzaba
    // «operator does not exist: public.moneda = text» en cada liga y el job
    // 4f9545e3 murió al 37 % con 101 movimientos YA insertados y 0
    // conciliados. Ahora cada movimiento va en su propio try/catch: el fallo
    // se cuenta con su motivo y el job termina LISTO diciendo cuántos.
    const ctx = await this.cargarCtxCruce();
    const conteo = conteoVacio();
    const detalle: ResultadoMovimiento[] = [];
    const porCriterio: Record<string, number> = {};
    const lista = inserted ?? [];
    if (lista.length !== rows.length) {
      // PostgREST puede devolver menos filas de las insertadas (max-rows): los
      // que no vuelven quedan SIN cruzar. Se dice en el log y «Cruzar
      // pendientes» los recupera — nunca se da por cruzado lo que no se miró.
      this.logger.warn(
        `Importación: se insertaron ${rows.length} movimientos y la BD devolvió ${lista.length}; los ${rows.length - lista.length} restantes quedan pendientes hasta correr auto-match.`,
      );
    }
    const pasoLote = Math.max(1, Math.ceil(lista.length / 25));
    for (let i = 0; i < lista.length; i++) {
      const m = lista[i];
      const r = await this.cruzarMovimiento(
        {
          id: m.id as string,
          cuenta_bancaria_id: dto.cuenta_bancaria_id,
          fecha: m.fecha as string,
          tipo: m.tipo as string,
          monto: Number(m.monto),
          monto_bruto: m.monto_bruto == null ? null : Number(m.monto_bruto),
          comision_monto:
            m.comision_monto == null ? null : Number(m.comision_monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          notas: null,
        },
        { moneda: monedaCuenta, tipo: cuentaInfo.tipo },
        ctx,
        userId,
      );
      sumarResultado(conteo, r.resultado);
      if (r.criterio)
        porCriterio[r.criterio] = (porCriterio[r.criterio] ?? 0) + 1;
      if (r.resultado !== 'CONCILIADO' && detalle.length < DETALLE_MAX) {
        detalle.push(r);
      }
      if (i % pasoLote === 0 || i === lista.length - 1) {
        await onProgress(
          35 + Math.round(((i + 1) / lista.length) * 60),
          `Conciliando ${i + 1} de ${lista.length}…`,
        );
      }
    }
    const conciliadosAuto = conteo.conciliados + conteo.traspasos;

    if (estadoCuentaId) {
      await this.supabase.service
        .from('estado_cuenta_archivo')
        .update({ movimientos_importados: rows.length })
        .eq('id', estadoCuentaId);
    }

    return {
      importados: rows.length,
      conciliados_auto: conciliadosAuto,
      duplicados_omitidos: duplicadosOmitidos,
      // ADITIVOS (15-sep-2026): el operador ve POR QUÉ quedó lo que quedó.
      conciliados: conteo.conciliados,
      traspasos: conteo.traspasos,
      ambiguos: conteo.ambiguos,
      sin_candidato: conteo.sin_candidato,
      rechazados: conteo.rechazados,
      errores: conteo.errores,
      por_criterio: porCriterio,
      detalle,
    };
  }

  /**
   * Guarda el archivo original del estado de cuenta en el bucket privado
   * `estados-cuenta` y registra la importación. Sin archivo (panel viejo) la
   * importación sigue funcionando; CON archivo, un fallo al archivar tumba
   * la importación a propósito (fail-loud): importar sin respaldo en
   * silencio dejaría la auditoría incompleta, y como aún no se insertó
   * ningún movimiento, reintentar es seguro.
   */
  private async archivarEstadoCuenta(
    dto: ImportarMovimientosDto,
    userId: string,
  ): Promise<string | null> {
    if (!dto.file_base64 || !dto.filename) return null;
    const limpio = dto.filename.replace(/[^\w.-]+/g, '_').slice(-120);
    const path = `${dto.cuenta_bancaria_id}/${Date.now()}-${limpio}`;
    const { error: upErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .upload(path, Buffer.from(dto.file_base64, 'base64'), {
        contentType: 'application/octet-stream',
      });
    if (upErr) {
      throw new InternalServerErrorException(
        `No se pudo archivar el estado de cuenta (${upErr.message}). Reintenta la importación.`,
      );
    }
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .insert({
        cuenta_bancaria_id: dto.cuenta_bancaria_id,
        filename: dto.filename,
        storage_path: path,
        formato: limpio.split('.').pop()?.toLowerCase() ?? null,
        created_by: userId,
      })
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data?.id as string) ?? null;
  }

  /** Estados de cuenta importados (para consultarlos/descargarlos después). */
  async listEstadosCuenta(cuentaBancariaId?: string) {
    let q = this.supabase.service
      .from('estado_cuenta_archivo')
      .select(
        'id, cuenta_bancaria_id, filename, formato, movimientos_importados, created_at, cuenta:cuenta_bancaria(banco, alias, moneda)',
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (cuentaBancariaId) q = q.eq('cuenta_bancaria_id', cuentaBancariaId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { data: data ?? [] };
  }

  /** URL firmada (1 h) para descargar un estado de cuenta archivado. */
  async estadoCuentaUrl(id: string) {
    const { data, error } = await this.supabase.service
      .from('estado_cuenta_archivo')
      .select('storage_path, filename')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Estado de cuenta ${id} not found`);
    const { data: signed, error: signErr } = await this.supabase.service.storage
      .from('estados-cuenta')
      .createSignedUrl(data.storage_path as string, 3600, {
        download: data.filename as string,
      });
    if (signErr || !signed?.signedUrl) {
      throw new Error(signErr?.message ?? 'No se pudo firmar la URL');
    }
    return { url: signed.signedUrl, filename: data.filename as string };
  }

  private async monedaCuenta(cuentaId: string): Promise<string | null> {
    return (await this.infoCuenta(cuentaId)).moneda;
  }

  /**
   * Moneda y tipo (BANCO | PASARELA) de la cuenta; null si no existe o si la
   * consulta falló. `cuenta_bancaria.moneda` es NOT NULL, así que un null
   * aquí SIEMPRE es un problema de lectura: se registra, y el auto-cruce lo
   * trata como ERROR (nunca cruza de oídas — sin moneda no se puede
   * garantizar que el gasto sea de la misma divisa).
   */
  private async infoCuenta(
    cuentaId: string,
  ): Promise<{ moneda: string | null; tipo: string | null }> {
    const { data, error } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('moneda, tipo')
      .eq('id', cuentaId)
      .maybeSingle();
    if (error || !data) {
      this.logger.warn(
        `No se pudo leer la cuenta ${cuentaId}: ${error?.message ?? 'no existe'}.`,
      );
    }
    return {
      moneda: (data?.moneda as string | null) ?? null,
      tipo: (data?.tipo as string | null) ?? null,
    };
  }

  /**
   * AUTO-CRUCE de un CARGO contra los gastos bancarios sin conciliar.
   *
   * Orden de desempate (fuente única `auto-cruce.util`, pura y probada):
   *  1. monto ±1 centavo + ventana ±MATCH_DAYS + moneda de la cuenta;
   *  2. si hay ≥2 candidatos, la TERMINACIÓN de tarjeta del movimiento
   *     (últimos 4 dígitos de `referencia`, validados contra
   *     `tarjeta_corporativa`) contra `gasto.tarjeta_terminacion`;
   *  3. si siguen ≥2, la DESCRIPCIÓN del banco contra `lugar` / primera
   *     línea de `notas` / proveedor del gasto (sinónimos del giro);
   *  4. si nada desempata ⇒ AMBIGUO (pendiente, JAMÁS se liga a la brava);
   *  5. sin candidato por monto: se prueba contra el FALTANTE de un gasto
   *     mayor con pagos parciales y, en cuenta MXN, la compra en USD por TC
   *     implícito.
   */
  private async autoMatchCargo(
    mov: {
      id: string;
      monto: number;
      fecha: string;
      descripcion: string | null;
      referencia: string | null;
    },
    moneda: string | null,
    userId: string,
    ctx: CruceCtx,
  ): Promise<ResultadoMovimiento> {
    const { desde, hasta } = ventanaDias(mov.fecha, MATCH_DAYS);
    const monto = Math.abs(Number(mov.monto)) || 0;
    const base = {
      movimiento_id: mov.id,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };

    // CANDADO DE MONEDA (invariante: jamás se cruzan divisas distintas sin
    // la regla del TC). `cuenta_bancaria.moneda` es NOT NULL: si aquí llega
    // null es que la cuenta no se pudo leer, y sin moneda la consulta de
    // candidatos NO filtraría divisa — un gasto de 125.82 USD cuadraría con
    // un cargo de 125.82 MXN. Se prefiere dejarlo pendiente.
    if (!moneda) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo:
          'No se pudo leer la moneda de la cuenta bancaria: el cruce no se intenta para no mezclar divisas.',
      };
    }

    // 1) Candidatos por monto (banda de centavos: la terminal redondea).
    const { data, error } = await this.gastosCandidatos({
      moneda,
      desde,
      hasta,
      montoMin: monto - TOLERANCIA_CENTAVOS,
      montoMax: monto + TOLERANCIA_CENTAVOS,
      limite: 25,
    });
    if (error) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo: `No se pudieron leer los gastos candidatos: ${error.message}`,
      };
    }
    const candidatos = (data ?? []).map((g) => this.aCandidatoCruce(g));
    if (candidatos.length > 0) {
      const eleccion = elegirCandidato(mov, candidatos, ctx.terminaciones);
      if (eleccion.gasto_id) {
        return this.ligarCargo(mov.id, eleccion.gasto_id, userId, {
          ...base,
          criterio: eleccion.criterio,
          candidatos_n: eleccion.candidatos_n,
        });
      }
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: eleccion.detalle,
      };
    }

    // 2) PAGO PARCIAL: el cargo puede cubrir lo que FALTA de un gasto mayor
    //    (una factura de ASUR pagada en dos cargos). Misma regla que
    //    `candidatosCercanos`, ahora también en automático.
    const parcial = await this.candidatoPorFaltante(
      monto,
      moneda,
      desde,
      hasta,
    );
    if (parcial.length > 0) {
      const eleccion = elegirCandidato(mov, parcial, ctx.terminaciones, {
        criterioBase: 'FALTANTE',
      });
      if (eleccion.gasto_id) {
        return this.ligarCargo(mov.id, eleccion.gasto_id, userId, {
          ...base,
          criterio: eleccion.criterio,
          candidatos_n: eleccion.candidatos_n,
        });
      }
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: eleccion.candidatos_n,
        motivo: eleccion.detalle,
      };
    }

    // 3) Cuenta MXN: compra EN DÓLARES cuyo cargo llegó en pesos (Aircraft
    //    Spruce). Solo con TC implícito plausible y candidato único.
    if (moneda === 'MXN' && monto > 0) {
      const { data: usd, error: usdErr } = await this.gastosCandidatos({
        moneda: 'USD',
        desde,
        hasta,
        limite: 25,
      });
      if (usdErr) {
        return {
          ...base,
          resultado: 'ERROR',
          motivo: `No se pudieron leer los gastos en USD: ${usdErr.message}`,
        };
      }
      const plausibles = (usd ?? [])
        .filter((g) => {
          const m = Number((g as { monto: unknown }).monto);
          if (!(m > 0)) return false;
          const tc = monto / m;
          return tc >= TC_IMPLICITO_MIN && tc <= TC_IMPLICITO_MAX;
        })
        .map((g) => this.aCandidatoCruce(g));
      // OJO (revisión 15-sep-2026): aquí el monto NO cuadra — la banda de TC
      // (15-25) acepta cualquier gasto USD dentro de un ±25 % del cargo. Por
      // eso este camino liga SOLO con candidato ÚNICO: desempatar por
      // descripción o por tarjeta entre montos que no coinciden sería ligar
      // «por parecerse», justo lo que el auto-cruce tiene prohibido.
      if (plausibles.length === 1) {
        return this.ligarCargo(mov.id, plausibles[0].id, userId, {
          ...base,
          criterio: 'TC_IMPLICITO',
          candidatos_n: 1,
        });
      }
      if (plausibles.length > 1) {
        return {
          ...base,
          resultado: 'AMBIGUO',
          candidatos_n: plausibles.length,
          motivo: `${plausibles.length} gastos en USD podrían corresponder a este cargo en pesos (tipo de cambio entre ${TC_IMPLICITO_MIN} y ${TC_IMPLICITO_MAX}): vincúlalo a mano.`,
        };
      }
    }
    return {
      ...base,
      motivo: `Ningún gasto bancario sin conciliar de ${montoBonito(monto)} ${moneda ?? ''} entre ${desde} y ${hasta}.`,
    };
  }

  /**
   * Gastos SIN conciliar, de medio bancario, en la ventana y (si se indica)
   * en esa moneda, con todo lo que el desempate necesita. Fuente única del
   * select para que el auto-cruce y el camino inverso no diverjan.
   */
  private async gastosCandidatos(opts: {
    moneda: string | null;
    desde: string;
    hasta: string;
    /** Banda [min, max] de monto (centavos). */
    montoMin?: number;
    montoMax?: number;
    /** Solo gastos MAYORES que esto (camino de pago parcial). */
    mayorQue?: number;
    limite: number;
  }): Promise<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }> {
    let q = this.supabase.service
      .from('gasto')
      .select(GASTO_CRUCE_COLS)
      .eq('conciliado', false)
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', opts.desde)
      .lte('fecha_gasto', opts.hasta);
    if (opts.moneda) q = q.eq('moneda', opts.moneda);
    if (opts.montoMin != null) q = q.gte('monto', opts.montoMin);
    if (opts.montoMax != null) q = q.lte('monto', opts.montoMax);
    if (opts.mayorQue != null) q = q.gt('monto', opts.mayorQue);
    const { data, error } = await q.limit(opts.limite);
    return {
      data: (data ?? null) as Array<Record<string, unknown>> | null,
      error: error ? { message: error.message } : null,
    };
  }

  /** Fila cruda de `gasto` → candidato del auto-cruce (util puro). */
  private aCandidatoCruce(g: Record<string, unknown>): GastoCandidatoCruce {
    const prov = unwrapOne(
      g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
    );
    return {
      id: g.id as string,
      monto: Number(g.monto) || 0,
      tarjeta_terminacion: (g.tarjeta_terminacion as string | null) ?? null,
      lugar: (g.lugar as string | null) ?? null,
      notas: (g.notas as string | null) ?? null,
      proveedor: typeof prov?.nombre === 'string' ? prov.nombre : null,
    };
  }

  /**
   * Gastos MAYORES que el cargo cuyo FALTANTE (monto − lo ya ligado) cuadra
   * con él: el segundo pago de una factura partida en dos cargos.
   */
  private async candidatoPorFaltante(
    monto: number,
    moneda: string | null,
    desde: string,
    hasta: string,
  ): Promise<GastoCandidatoCruce[]> {
    if (!(monto > 0)) return [];
    const { data, error } = await this.gastosCandidatos({
      moneda,
      desde,
      hasta,
      mayorQue: monto + TOLERANCIA_CENTAVOS,
      limite: 40,
    });
    if (error || !data || data.length === 0) return [];
    const ligado = await this.sumasLigadasDe(data.map((g) => g.id as string));
    return data
      .filter((g) => {
        const suma = ligado.get(g.id as string) ?? 0;
        if (!(suma > 0)) return false;
        return montoCasa(faltanteDe(Number(g.monto), suma), monto);
      })
      .map((g) => this.aCandidatoCruce(g));
  }

  /** Aplica la liga del auto-cruce y traduce el desenlace a ResultadoMovimiento. */
  private async ligarCargo(
    movId: string,
    gastoId: string,
    userId: string,
    base: Omit<ResultadoMovimiento, 'resultado' | 'motivo'> & {
      motivo?: string | null;
    },
  ): Promise<ResultadoMovimiento> {
    const liga = await this.ligarAuto(movId, gastoId, userId);
    if (liga.ok) {
      return {
        ...base,
        resultado: 'CONCILIADO',
        gasto_id: gastoId,
        motivo: null,
      };
    }
    return {
      ...base,
      resultado: liga.rechazado ? 'RECHAZADO' : 'ERROR',
      criterio: null,
      motivo: liga.motivo,
    };
  }

  /**
   * Liga del auto-match. NADA que salga de aquí puede tumbar la importación
   * (15-sep-2026): un 409 (gasto ya cubierto, carrera con otra liga) deja el
   * movimiento pendiente, y CUALQUIER otro error (el 23514 del trigger, un
   * 5xx de PostgREST, una desconexión) se registra y se sigue con el
   * siguiente movimiento. Antes solo se atrapaba ConflictException y un
   * error del trigger mataba el job entero con todo a medias.
   */
  private async ligarAuto(
    movId: string,
    gastoId: string,
    userId: string,
  ): Promise<{ ok: boolean; rechazado: boolean; motivo: string | null }> {
    try {
      await this.link(movId, gastoId, userId);
      return { ok: true, rechazado: false, motivo: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictException) {
        this.logger.warn(
          `auto-match: el gasto ${gastoId} no admite el cargo ${movId} (${msg}); queda pendiente.`,
        );
        return {
          ok: false,
          rechazado: true,
          motivo: `El gasto candidato no admite este cargo (${msg}).`,
        };
      }
      this.logger.error(
        `auto-match: fallo al ligar el cargo ${movId} con el gasto ${gastoId}: ${msg}`,
      );
      return { ok: false, rechazado: false, motivo: msg };
    }
  }

  /**
   * Gemelo de `ligarAuto` para los ABONOS: `linkCobro` puede lanzar 409
   * (el cobro ya lo tomó otro movimiento) o cualquier error de BD, y ni uno
   * ni otro pueden tumbar la importación.
   */
  private async ligarCobroAuto(
    movId: string,
    liga: LigaCobroInput,
    userId: string,
  ): Promise<{ ok: boolean; rechazado: boolean; motivo: string | null }> {
    try {
      await this.linkCobro(movId, liga, userId);
      return { ok: true, rechazado: false, motivo: null };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof ConflictException) {
        this.logger.warn(`auto-match abono ${movId}: ${msg}; queda pendiente.`);
        return {
          ok: false,
          rechazado: true,
          motivo: `El cobro candidato ya no admite este abono (${msg}).`,
        };
      }
      this.logger.error(`auto-match abono ${movId}: ${msg}`);
      return { ok: false, rechazado: false, motivo: msg };
    }
  }

  // =====================================================================
  // RE-CRUCE (15-sep-2026): el auto-cruce ya no vive SOLO dentro del import
  // =====================================================================

  /** Contexto del auto-cruce: se carga UNA vez por corrida, no por fila. */
  private async cargarCtxCruce(): Promise<CruceCtx> {
    const { data, error } = await this.supabase.service
      .from('tarjeta_corporativa')
      .select('terminacion, activa')
      .limit(200);
    if (error) {
      // Sin catálogo no hay desempate por tarjeta, pero el cruce sigue.
      this.logger.warn(`No se pudo leer tarjeta_corporativa: ${error.message}`);
      return { terminaciones: [] };
    }
    return {
      terminaciones: (data ?? [])
        .map((t) => (t as { terminacion: unknown }).terminacion)
        .filter((t): t is string => typeof t === 'string'),
    };
  }

  /**
   * Id de la clasificación «Traspaso entre cuentas» (se crea la primera vez
   * que hace falta; `crearClasificacion` ya es idempotente por nombre).
   */
  private async idClasificacionTraspaso(
    ctx: CruceCtx,
    userId: string,
  ): Promise<string | null> {
    if (ctx.clasificacionTraspaso !== undefined)
      return ctx.clasificacionTraspaso;
    try {
      const clasif = await this.crearClasificacion(
        CLASIFICACION_TRASPASO,
        userId,
      );
      ctx.clasificacionTraspaso = (clasif as { id: string }).id;
    } catch (err) {
      this.logger.warn(
        `No se pudo preparar la clasificación «${CLASIFICACION_TRASPASO}»: ${err instanceof Error ? err.message : String(err)}`,
      );
      ctx.clasificacionTraspaso = null;
    }
    return ctx.clasificacionTraspaso;
  }

  /**
   * TRASPASOS INTERNOS (regla por descripción): «SEL TRASPASO ENTRE
   * CUENTAS» y compañía no tienen gasto ni cobro detrás — el dinero solo
   * cambió de cuenta. Sin esta regla quedaban pendientes para siempre e
   * inflaban el «faltan N por conciliar» del cierre. Se clasifican con la
   * clasificación canónica y una nota que dice de dónde salió.
   */
  private async aplicarTraspaso(
    mov: { id: string; descripcion: string | null; notas?: string | null },
    ctx: CruceCtx,
    userId: string,
  ): Promise<ResultadoMovimiento | null> {
    const patron = patronTraspaso(mov.descripcion);
    if (!patron) return null;
    const clasifId = await this.idClasificacionTraspaso(ctx, userId);
    if (!clasifId) return null;
    const nota = `Regla: ${patron}`;
    await this.clasificarMovimiento(
      mov.id,
      clasifId,
      // Nunca se pisa lo que escribió la oficina.
      mov.notas ? undefined : nota,
      userId,
    );
    return {
      movimiento_id: mov.id,
      resultado: 'TRASPASO',
      criterio: 'REGLA',
      motivo: `Traspaso entre cuentas (regla «${patron}»).`,
      candidatos_n: 0,
    };
  }

  /**
   * Cruza UN movimiento pendiente (regla de traspaso → gasto si es CARGO →
   * cobro si es ABONO). Nunca lanza: el fallo se devuelve como resultado
   * ERROR con su motivo para que el job lo cuente y siga.
   */
  private async cruzarMovimiento(
    mov: {
      id: string;
      cuenta_bancaria_id: string;
      fecha: string;
      tipo: string;
      monto: number;
      monto_bruto?: number | null;
      comision_monto?: number | null;
      descripcion: string | null;
      referencia: string | null;
      notas?: string | null;
    },
    cuenta: { moneda: string | null; tipo: string | null },
    ctx: CruceCtx,
    userId: string,
  ): Promise<ResultadoMovimiento> {
    try {
      const traspaso = await this.aplicarTraspaso(mov, ctx, userId);
      if (traspaso) return traspaso;
      // Sin la moneda de la cuenta ninguna consulta de candidatos filtra
      // divisa: un cobro/gasto de 125.82 USD cuadraría con 125.82 MXN. La
      // columna es NOT NULL, así que esto solo pasa si la cuenta no se pudo
      // leer — se cuenta como ERROR y el movimiento queda pendiente.
      if (!cuenta.moneda) {
        return {
          movimiento_id: mov.id,
          resultado: 'ERROR',
          criterio: null,
          motivo:
            'No se pudo leer la moneda de la cuenta bancaria: el cruce no se intenta para no mezclar divisas.',
          candidatos_n: 0,
        };
      }
      if (mov.tipo === (TipoMovimientoBancario.CARGO as string)) {
        return await this.autoMatchCargo(
          {
            id: mov.id,
            monto: mov.monto,
            fecha: mov.fecha,
            descripcion: mov.descripcion,
            referencia: mov.referencia,
          },
          cuenta.moneda,
          userId,
          ctx,
        );
      }
      if (cuenta.tipo === TIPO_CUENTA_PASARELA) {
        return await this.autoMatchAbonoPasarela(
          {
            id: mov.id,
            fecha: mov.fecha,
            monto: Number(mov.monto),
            monto_bruto: mov.monto_bruto ?? null,
            comision_monto: mov.comision_monto ?? null,
            referencia: mov.referencia,
            descripcion: mov.descripcion,
            moneda: cuenta.moneda,
          },
          userId,
        );
      }
      return await this.autoMatchAbono(
        mov.id,
        mov.monto,
        mov.fecha,
        cuenta.moneda,
        userId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`auto-cruce del movimiento ${mov.id}: ${msg}`);
      return {
        movimiento_id: mov.id,
        resultado: 'ERROR',
        criterio: null,
        motivo: msg,
        candidatos_n: 0,
      };
    }
  }

  /**
   * RE-CRUCE de los movimientos PENDIENTES de una ventana (15-sep-2026).
   *
   * Hasta hoy el auto-cruce corría SOLO dentro del bucle de importación: si
   * fallaba (el 15-sep, el trigger con el ENUM de moneda) los movimientos ya
   * insertados se quedaban pendientes PARA SIEMPRE — re-importar respondía
   * «101 duplicados» y no reintentaba el cruce de nadie. Este método vuelve
   * a correr EXACTAMENTE la misma lógica (reglas + cargos + abonos) sobre lo
   * que sigue sin conciliar, y cuenta por qué quedó cada uno.
   */
  async autoMatchPendientes(dto: AutoMatchDto, userId: string) {
    // Re-cruce DIRIGIDO: con ids explícitos la ventana de fechas no aplica
    // (el operador señaló exactamente qué filas reintentar).
    const ids = dto.movimiento_ids?.length ? dto.movimiento_ids : null;
    const hasta = dto.hasta ?? hoyCancun();
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (!ids && desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const limite = Math.min(dto.limite ?? 500, RECRUCE_MAX);

    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, cuenta_bancaria_id, fecha, tipo, monto, monto_bruto, comision_monto, descripcion, referencia, notas',
      )
      .eq('conciliado', false)
      .order('fecha', { ascending: true })
      .limit(limite);
    if (ids) q = q.in('id', ids);
    else q = q.gte('fecha', desde).lte('fecha', hasta);
    if (dto.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const movs = (data ?? []) as Array<Record<string, unknown>>;

    const ctx = await this.cargarCtxCruce();
    const cuentas = new Map<
      string,
      { moneda: string | null; tipo: string | null }
    >();
    const conteo = conteoVacio();
    const porCriterio: Record<string, number> = {};
    const detalle: ResultadoMovimiento[] = [];

    for (const m of movs) {
      const cuentaId = m.cuenta_bancaria_id as string;
      if (!cuentas.has(cuentaId)) {
        cuentas.set(cuentaId, await this.infoCuenta(cuentaId));
      }
      const r = await this.cruzarMovimiento(
        {
          id: m.id as string,
          cuenta_bancaria_id: cuentaId,
          fecha: m.fecha as string,
          tipo: m.tipo as string,
          monto: Number(m.monto),
          monto_bruto: m.monto_bruto == null ? null : Number(m.monto_bruto),
          comision_monto:
            m.comision_monto == null ? null : Number(m.comision_monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          notas: (m.notas as string | null) ?? null,
        },
        cuentas.get(cuentaId)!,
        ctx,
        userId,
      );
      sumarResultado(conteo, r.resultado);
      if (r.criterio)
        porCriterio[r.criterio] = (porCriterio[r.criterio] ?? 0) + 1;
      if (detalle.length < DETALLE_MAX) detalle.push(r);
    }

    return {
      revisados: movs.length,
      conciliados: conteo.conciliados,
      traspasos: conteo.traspasos,
      ambiguos: conteo.ambiguos,
      sin_candidato: conteo.sin_candidato,
      rechazados: conteo.rechazados,
      errores: conteo.errores,
      por_criterio: porCriterio,
      desde,
      hasta,
      cuenta_bancaria_id: dto.cuenta_bancaria_id ?? null,
      limite,
      truncado: movs.length >= limite,
      detalle_truncado: movs.length > detalle.length,
      detalle,
    };
  }

  /**
   * CAMINO INVERSO (15-sep-2026): un gasto capturado DESPUÉS de importar el
   * estado de cuenta jamás se cruzaba solo — el auto-cruce solo corría al
   * importar y el operador tenía que acordarse de volver a la pestaña.
   *
   * Se llama best-effort desde `expenses.service` al crear/editar un gasto
   * bancario: NUNCA lanza (un fallo aquí no puede tumbar el alta del gasto)
   * y liga solo si hay UN cargo pendiente inequívoco (misma disciplina que
   * el auto-cruce: tarjeta y descripción desempatan, el empate no liga).
   */
  async intentarCruzarGasto(
    gastoId: string,
    userId: string,
  ): Promise<{
    ligado: boolean;
    movimiento_id: string | null;
    motivo: string;
  }> {
    const nada = (motivo: string) => ({
      ligado: false,
      movimiento_id: null,
      motivo,
    });
    try {
      const { data: gasto, error } = await this.supabase.service
        .from('gasto')
        .select(`${GASTO_CRUCE_COLS}, conciliado`)
        .eq('id', gastoId)
        .maybeSingle();
      if (error) return nada(error.message);
      if (!gasto) return nada('El gasto ya no existe.');
      const g = gasto as unknown as Record<string, unknown>;
      if (g.conciliado === true) return nada('El gasto ya está conciliado.');
      const medio = (g.medio_pago as string | null) ?? '';
      if (!MEDIOS_BANCARIOS.includes(medio)) {
        return nada(`El medio ${medio || '(vacío)'} no toca el banco.`);
      }
      const fecha = (g.fecha_gasto as string | null) ?? null;
      const monto = Math.abs(Number(g.monto)) || 0;
      const moneda = (g.moneda as string | null) ?? null;
      if (!fecha || !(monto > 0)) return nada('Gasto sin fecha o sin monto.');
      // `gasto.moneda` es NOT NULL: sin ella no se puede garantizar que el
      // cargo sea de la misma divisa (el filtro de cuentas quedaría abierto).
      if (!moneda) return nada('El gasto no tiene moneda: no se cruza solo.');

      // Pagos parciales: lo que este gasto todavía espera del banco.
      const ligado = (await this.sumasLigadasDe([gastoId])).get(gastoId) ?? 0;
      const objetivo = ligado > 0 ? faltanteDe(monto, ligado) : monto;
      if (!(objetivo > 0)) return nada('El gasto ya está cubierto.');

      // Cuentas de la MISMA moneda del gasto (un cargo de otra moneda es el
      // caso cruzado USD↔MXN: 1 ↔ 1, se deja al operador).
      const { data: cuentas, error: ctaErr } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, moneda')
        .limit(100);
      if (ctaErr) return nada(ctaErr.message);
      const ids = (cuentas ?? [])
        .filter((c) => (c as { moneda: string }).moneda === moneda)
        .map((c) => (c as { id: string }).id);
      if (ids.length === 0) return nada('No hay cuentas de esa moneda.');

      const { desde, hasta } = ventanaDias(fecha, MATCH_DAYS);
      const { data: movs, error: movErr } = await this.supabase.service
        .from('movimiento_bancario')
        .select('id, monto, descripcion, referencia')
        .eq('conciliado', false)
        .eq('tipo', TipoMovimientoBancario.CARGO)
        .in('cuenta_bancaria_id', ids)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .gte('monto', objetivo - TOLERANCIA_CENTAVOS)
        .lte('monto', objetivo + TOLERANCIA_CENTAVOS)
        .limit(15);
      if (movErr) return nada(movErr.message);
      const candidatos = (movs ?? []).map((m) => ({
        id: (m as { id: string }).id,
        monto: Number((m as { monto: unknown }).monto) || 0,
        descripcion: (m as { descripcion?: string | null }).descripcion ?? null,
        referencia: (m as { referencia?: string | null }).referencia ?? null,
      }));
      if (candidatos.length === 0) {
        return nada('Ningún cargo pendiente del banco cuadra con el gasto.');
      }
      const ctx = await this.cargarCtxCruce();
      const eleccion = elegirMovimiento(
        this.aCandidatoCruce(g),
        candidatos,
        ctx.terminaciones,
      );
      if (!eleccion.movimiento_id) {
        return nada(
          `${candidatos.length} cargos del banco cuadran con el gasto: vincúlalo a mano.`,
        );
      }
      const liga = await this.ligarAuto(
        eleccion.movimiento_id,
        gastoId,
        userId,
      );
      if (!liga.ok) return nada(liga.motivo ?? 'No se pudo ligar.');
      this.logger.log(
        `auto-cruce inverso: el gasto ${gastoId} se ligó con el cargo ${eleccion.movimiento_id} (${eleccion.criterio}).`,
      );
      return {
        ligado: true,
        movimiento_id: eleccion.movimiento_id,
        motivo: `Ligado por ${eleccion.criterio}.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`auto-cruce inverso del gasto ${gastoId}: ${msg}`);
      return nada(msg);
    }
  }

  /**
   * Ventana [fecha − días, fecha + días] en hora CANCÚN (invariante 4). La
   * `fecha` del banco es un DATE y `cobro_vuelo.fecha_cobro` es timestamptz:
   * con cortes en UTC la ventana real iba de las 19:00 Cancún del día
   * −(N+1) a las 18:59 del día +N y un cobro capturado a las 20:00 del
   * último día quedaba fuera. Mismos cortes que `cobrosSinBanco`.
   */
  private ventanaAbono(
    fecha: string,
    dias: number,
  ): { lo: string; hi: string } {
    const { desde, hasta } = ventanaDias(fecha, dias);
    return { lo: `${desde}T00:00:00-05:00`, hi: `${hasta}T23:59:59-05:00` };
  }

  /**
   * ABONO = entrada de dinero. Se cruza contra los COBROS de vuelos (HSBC
   * link, transferencia) del mismo monto/moneda ±N días que aún no estén
   * enlazados a otro movimiento. Con esto la mitad "ingresos" del estado de
   * cuenta también se concilia sola.
   *
   * SOBRES de grupo (4-sep-2026): el pago único de un grupo es UN abono del
   * banco → el candidato es el `cobro_grupo` (bruto o neto), nunca sus
   * partes (`cobro_vuelo.cobro_grupo_id`, excluidas de la consulta: una
   * parte de $2,060.16 cuadraría en falso con un depósito ajeno del mismo
   * monto). Candidato ÚNICO entre cobros y sobres: si empatan un cobro y un
   * sobre, es ambiguo y no se cruza.
   */
  private async autoMatchAbono(
    movId: string,
    monto: number,
    fecha: string,
    moneda: string | null,
    userId: string,
  ): Promise<ResultadoMovimiento> {
    const { lo, hi } = this.ventanaAbono(fecha, MATCH_DAYS);
    const base = {
      movimiento_id: movId,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };

    // El banco deposita monto − comisión bancaria: el abono real es el NETO.
    // Se matchea por bruto (cobros sin comisión) O por neto (con comisión) —
    // antes solo por bruto y los cobros con comisión jamás conciliaban.
    let q = this.supabase.service
      .from('cobro_vuelo')
      .select('id, monto, comision_banco_monto')
      // Solo cobros POSITIVOS: un REEMBOLSO (monto negativo, 29-ago) sale
      // como CARGO en el banco, no como abono — queda FUERA de la
      // conciliación automática en v1 (se cruza a mano si hace falta).
      .gt('monto', 0)
      // Las PARTES de un sobre nunca son candidatas: se concilia el sobre.
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', METODOS_ABONO_AUTO)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      // Orden estable: si la ventana excede el tope, el corte es determinista.
      .order('fecha_cobro', { ascending: true })
      .limit(50);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select('id, monto, comision_banco_monto')
      .gt('monto', 0)
      .in('metodo_cobro', METODOS_ABONO_AUTO)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(50);
    if (moneda) {
      q = q.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const [cobrosRes, sobresRes] = await Promise.all([q, qs]);
    if (cobrosRes.error || sobresRes.error) {
      return {
        ...base,
        resultado: 'ERROR',
        motivo: `No se pudieron leer los cobros candidatos: ${cobrosRes.error?.message ?? sobresRes.error?.message ?? ''}`,
      };
    }

    const matchea = (c: { monto: unknown; comision_banco_monto: unknown }) => {
      const bruto = Number(c.monto);
      const comision = Number(c.comision_banco_monto) || 0;
      if (comision > 0) return r2(bruto - comision) === r2(monto);
      return r2(bruto) === r2(monto);
    };
    type Cand = { id: string; monto: unknown; comision_banco_monto: unknown };
    const cobroIds = ((cobrosRes.data ?? []) as Cand[])
      .filter(matchea)
      .map((c) => c.id);
    const sobreIds = ((sobresRes.data ?? []) as Cand[])
      .filter(matchea)
      .map((c) => c.id);
    if (cobroIds.length === 0 && sobreIds.length === 0) {
      return {
        ...base,
        motivo: `Ningún cobro bancario de ${montoBonito(monto)} ${moneda ?? ''} entre ${lo.slice(0, 10)} y ${hi.slice(0, 10)}.`,
      };
    }

    // Descarta cobros/sobres ya enlazados a otro movimiento; exige candidato
    // único ENTRE AMBOS universos.
    const filtro = filtroLigaCobros(cobroIds, sobreIds);
    const { data: yaEnlazados } = filtro
      ? await this.supabase.service
          .from('movimiento_bancario')
          .select(MOV_LIGA_COLS)
          .or(filtro)
      : { data: [] as MovimientoLiga[] };
    const ocupadosCobro = new Set<string>();
    const ocupadosSobre = new Set<string>();
    for (const m of (yaEnlazados ?? []) as MovimientoLiga[]) {
      if (typeof m.cobro_id === 'string') ocupadosCobro.add(m.cobro_id);
      if (typeof m.cobro_grupo_id === 'string')
        ocupadosSobre.add(m.cobro_grupo_id);
    }
    const libresCobro = cobroIds.filter((id) => !ocupadosCobro.has(id));
    const libresSobre = sobreIds.filter((id) => !ocupadosSobre.has(id));
    const n = libresCobro.length + libresSobre.length;
    if (n === 0) {
      return {
        ...base,
        motivo: `Ningún cobro bancario libre de ${montoBonito(monto)} ${moneda ?? ''} entre ${lo.slice(0, 10)} y ${hi.slice(0, 10)}.`,
      };
    }
    if (n > 1) {
      return {
        ...base,
        resultado: 'AMBIGUO',
        candidatos_n: n,
        motivo: `${n} cobros/sobres cuadran con este abono: vincúlalo a mano.`,
      };
    }

    const liga: LigaCobroInput =
      libresCobro.length === 1
        ? { cobro_id: libresCobro[0] }
        : { cobro_grupo_id: libresSobre[0] };
    const r = await this.ligarCobroAuto(movId, liga, userId);
    if (r.ok) {
      return {
        ...base,
        resultado: 'CONCILIADO',
        criterio: 'MONTO_EXACTO',
        candidatos_n: 1,
        cobro_id: liga.cobro_id ?? null,
        cobro_grupo_id: liga.cobro_grupo_id ?? null,
      };
    }
    return {
      ...base,
      resultado: r.rechazado ? 'RECHAZADO' : 'ERROR',
      candidatos_n: 1,
      motivo: r.motivo,
    };
  }

  /**
   * Vincula un ABONO con un cobro de vuelo (`cobro_id`) O con el SOBRE de un
   * grupo (`cobro_grupo_id`) — excluyentes (CHECK
   * movimiento_bancario_cobro_excluyente). Ambos null = desvincular (limpia
   * las dos ligas). Una PARTE de sobre jamás se enlaza: 409 COBRO_DE_GRUPO
   * («concilia contra el sobre del grupo G-n»).
   */
  async linkCobro(movId: string, liga: LigaCobroInput, userId: string) {
    const cobroId = liga.cobro_id ?? null;
    const sobreId = liga.cobro_grupo_id ?? null;
    if (cobroId && sobreId) {
      throw new BadRequestException(
        'Indica un cobro de vuelo O un sobre de grupo, no los dos.',
      );
    }
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    if (cobroId) {
      const { data: cobro, error: cobroErr } = await this.supabase.service
        .from('cobro_vuelo')
        .select(
          'id, cobro_grupo_id, sobre:cobro_grupo!cobro_grupo_id(grupo:vuelo_grupo!grupo_id(folio))',
        )
        .eq('id', cobroId)
        .maybeSingle();
      if (cobroErr) throw new Error(cobroErr.message);
      if (!cobro) throw new BadRequestException('Cobro no encontrado.');
      if (esParteDeSobre(cobro)) {
        const sobre = unwrapOne(
          cobro.sobre as {
            grupo?: { folio?: unknown } | { folio?: unknown }[] | null;
          } | null,
        );
        const folioRaw = unwrapOne(sobre?.grupo)?.folio;
        const grupoFolio = folioRaw == null ? null : Number(folioRaw);
        const g = `G-${grupoFolio ?? '?'}`;
        throw new ConflictException({
          message: `Este cobro es parte del sobre del grupo ${g}: concilia el abono contra el sobre del grupo ${g}, no contra sus partes.`,
          error: 'COBRO_DE_GRUPO',
          details: {
            cobro_id: cobroId,
            cobro_grupo_id: cobro.cobro_grupo_id as string,
            grupo_folio: grupoFolio,
          },
        });
      }
      // Un cobro ya enlazado a OTRO movimiento no puede cuadrar una segunda
      // línea del banco (el auto-match ya lo respeta; el manual también).
      const { data: yaEnlazado, error: ocupadoErr } =
        await this.supabase.service
          .from('movimiento_bancario')
          .select('id')
          .eq('cobro_id', cobroId)
          .neq('id', movId)
          .limit(1)
          .maybeSingle();
      if (ocupadoErr) throw new Error(ocupadoErr.message);
      if (yaEnlazado) {
        throw new ConflictException(
          'Ese cobro ya está conciliado con otro movimiento bancario.',
        );
      }
    }

    if (sobreId) {
      const { data: sobre, error: sobreErr } = await this.supabase.service
        .from('cobro_grupo')
        .select('id')
        .eq('id', sobreId)
        .maybeSingle();
      if (sobreErr) throw new Error(sobreErr.message);
      if (!sobre) {
        throw new BadRequestException('Cobro de grupo (sobre) no encontrado.');
      }
      const { data: yaEnlazado, error: ocupadoErr } =
        await this.supabase.service
          .from('movimiento_bancario')
          .select('id')
          .eq('cobro_grupo_id', sobreId)
          .neq('id', movId)
          .limit(1)
          .maybeSingle();
      if (ocupadoErr) throw new Error(ocupadoErr.message);
      if (yaEnlazado) {
        throw new ConflictException(
          'Ese sobre de grupo ya está conciliado con otro movimiento bancario.',
        );
      }
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        cobro_id: cobroId,
        cobro_grupo_id: sobreId,
        conciliado:
          cobroId !== null ||
          sobreId !== null ||
          (mov as { gasto_id: string | null }).gasto_id !== null,
        // Vincular un cobro real pisa la clasificación "sin vuelo".
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      // Índices únicos uq_mov_bancario_cobro / uq_mov_bancario_cobro_grupo:
      // dos vínculos simultáneos al mismo cobro/sobre pasan el check previo
      // (TOCTOU) pero solo uno gana en la BD.
      if (error.code === '23505' || error.message?.includes('23505'))
        throw new ConflictException(
          sobreId
            ? 'Ese sobre de grupo ya está vinculado a otro movimiento bancario.'
            : 'Ese cobro ya está vinculado a otro movimiento bancario.',
        );
      if (error.code === '23503')
        throw new BadRequestException(
          sobreId ? 'Cobro de grupo no encontrado.' : 'Cobro no encontrado.',
        );
      if (error.code === '23514')
        throw new BadRequestException(
          'Un movimiento no puede ligar un cobro de vuelo y un sobre de grupo a la vez.',
        );
      throw new Error(error.message);
    }
    return data!;
  }

  /** Partes (cobro_vuelo) por sobre: cuántos aviones recibieron parte. */
  private async contarPartesPorSobre(
    sobreIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(sobreIds.filter(Boolean))];
    if (ids.length === 0) return out;
    const { data, error } = await this.supabase.service
      .from('cobro_vuelo')
      .select('cobro_grupo_id')
      .in('cobro_grupo_id', ids)
      .limit(10000);
    if (error) throw new Error(error.message);
    for (const p of data ?? []) {
      const sid = p.cobro_grupo_id as string;
      out.set(sid, (out.get(sid) ?? 0) + 1);
    }
    return out;
  }

  /** Fila cruda de cobro_grupo (+ grupo embebido) → forma pública SOBRE_GRUPO. */
  private normalizarSobre(
    raw: Record<string, unknown>,
    avionesN: number,
  ): SobreConciliacion {
    const grupo = unwrapOne(
      raw.grupo as { folio?: unknown; nombre?: unknown } | null,
    );
    const monto = Number(raw.monto) || 0;
    const comision = Number(raw.comision_banco_monto) || 0;
    const metodo = (raw.metodo_cobro as string) ?? '';
    const fecha = (raw.fecha_cobro as string) ?? '';
    return {
      tipo: 'SOBRE_GRUPO',
      cobro_grupo_id: raw.id as string,
      grupo_id: raw.grupo_id as string,
      grupo_folio: grupo?.folio == null ? null : Number(grupo.folio),
      grupo_nombre: typeof grupo?.nombre === 'string' ? grupo.nombre : null,
      monto: r2(monto),
      moneda: (raw.moneda as string) ?? 'USD',
      metodo,
      metodo_cobro: metodo,
      fecha,
      fecha_cobro: fecha,
      referencia: (raw.referencia as string | null) ?? null,
      comision_banco_monto: comision > 0 ? r2(comision) : null,
      neto: r2(monto - (comision > 0 ? comision : 0)),
      aviones_n: avionesN,
    };
  }

  /**
   * Movimientos con el embed `cobro_grupo` (SOBRE_EMBED) → cada fila gana
   * `cobro_grupo: SobreConciliacion | null` (aditivo; `cobro` y `gasto`
   * siguen igual).
   */
  private async normalizarSobresEnMovs(
    movs: Array<Record<string, unknown>>,
  ): Promise<Array<Record<string, unknown>>> {
    const crudos = new Map<string, Record<string, unknown>>();
    for (const m of movs) {
      const raw = unwrapOne<Record<string, unknown>>(
        m.cobro_grupo as Record<string, unknown> | null,
      );
      if (raw && typeof raw.id === 'string') crudos.set(raw.id, raw);
    }
    if (crudos.size === 0) {
      return movs.map((m) => ({ ...m, cobro_grupo: null }));
    }
    const partes = await this.contarPartesPorSobre([...crudos.keys()]);
    return movs.map((m) => {
      const raw = unwrapOne<Record<string, unknown>>(
        m.cobro_grupo as Record<string, unknown> | null,
      );
      return {
        ...m,
        cobro_grupo:
          raw && typeof raw.id === 'string'
            ? this.normalizarSobre(raw, partes.get(raw.id) ?? 0)
            : null,
      };
    });
  }

  /**
   * Candidatos para conciliar un ABONO a mano: cobros de vuelo Y sobres de
   * grupo (misma moneda que la cuenta, métodos que llegan al banco, sin
   * conciliar con OTRO movimiento) en ±`dias`, ordenados por cercanía del
   * NETO al monto del abono y luego por fecha. Las PARTES de un sobre nunca
   * se ofrecen (se concilia el sobre, que es lo que depositó el cliente).
   */
  async candidatosCobro(
    movId: string,
    dias: number = CANDIDATOS_DIAS_DEFAULT,
  ): Promise<{
    movimiento: {
      id: string;
      fecha: string;
      monto: number;
      tipo: string;
      moneda: string | null;
      cobro_id: string | null;
      cobro_grupo_id: string | null;
    };
    candidatos: CandidatoCobro[];
    exactos: number;
  }> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, cuenta_bancaria_id, cobro_id, cobro_grupo_id',
      )
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);
    if (mov.tipo !== TipoMovimientoBancario.ABONO) {
      throw new BadRequestException(
        'Solo un ABONO (entrada de dinero) se concilia contra cobros de vuelo o sobres de grupo.',
      );
    }
    const moneda = await this.monedaCuenta(mov.cuenta_bancaria_id as string);
    const { lo, hi } = this.ventanaAbono(mov.fecha as string, dias);

    let qc = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(300);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', METODOS_ABONO_MANUAL)
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(100);
    if (moneda) {
      qc = qc.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const [cobrosRes, sobresRes] = await Promise.all([qc, qs]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (sobresRes.error) throw new Error(sobresRes.error.message);
    const cobros = (cobrosRes.data ?? []) as Array<Record<string, unknown>>;
    const sobres = (sobresRes.data ?? []) as Array<Record<string, unknown>>;

    // Ya conciliados con OTRO movimiento (fuente única: MOV_LIGA_COLS).
    const filtro = filtroLigaCobros(
      cobros.map((c) => c.id as string),
      sobres.map((s) => s.id as string),
    );
    const ocupadosCobro = new Set<string>();
    const ocupadosSobre = new Set<string>();
    if (filtro) {
      const { data: ligas, error: ligasErr } = await this.supabase.service
        .from('movimiento_bancario')
        .select(MOV_LIGA_COLS)
        .or(filtro);
      if (ligasErr) throw new Error(ligasErr.message);
      for (const m of (ligas ?? []) as MovimientoLiga[]) {
        if (m.id === movId) continue;
        if (typeof m.cobro_id === 'string') ocupadosCobro.add(m.cobro_id);
        if (typeof m.cobro_grupo_id === 'string')
          ocupadosSobre.add(m.cobro_grupo_id);
      }
    }
    const partesN = await this.contarPartesPorSobre(
      sobres.map((s) => s.id as string),
    );

    const montoMov = Number(mov.monto) || 0;
    const refMs = Date.parse(`${mov.fecha as string}T00:00:00Z`);
    const candidatos: CandidatoCobro[] = [
      ...cobros
        .filter((c) => !ocupadosCobro.has(c.id as string))
        .map((c): CandidatoCobroVuelo => {
          const vuelo = unwrapOne(
            c.vuelo as {
              folio?: unknown;
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(vuelo?.cliente);
          const bruto = Number(c.monto) || 0;
          const comision = Number(c.comision_banco_monto) || 0;
          const neto = r2(bruto - (comision > 0 ? comision : 0));
          return {
            tipo: 'COBRO_VUELO',
            id: c.id as string,
            cobro_id: c.id as string,
            vuelo_id: c.vuelo_id as string,
            folio: vuelo?.folio == null ? null : Number(vuelo.folio),
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            fecha_cobro: c.fecha_cobro as string,
            monto: r2(bruto),
            moneda: c.moneda as string,
            metodo_cobro: c.metodo_cobro as string,
            referencia: (c.referencia as string | null) ?? null,
            comision_banco_monto: comision > 0 ? r2(comision) : null,
            neto,
            dif_monto: r2(Math.abs(neto - montoMov)),
          };
        }),
      ...sobres
        .filter((s) => !ocupadosSobre.has(s.id as string))
        .map((s): CandidatoSobreGrupo => {
          const norm = this.normalizarSobre(
            s,
            partesN.get(s.id as string) ?? 0,
          );
          const grupo = unwrapOne(
            s.grupo as {
              cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
            } | null,
          );
          const cliente = unwrapOne(grupo?.cliente);
          return {
            ...norm,
            id: norm.cobro_grupo_id,
            cliente:
              typeof cliente?.nombre === 'string' ? cliente.nombre : null,
            dif_monto: r2(Math.abs(norm.neto - montoMov)),
          };
        }),
    ]
      .sort(
        (a, b) =>
          a.dif_monto - b.dif_monto ||
          Math.abs(Date.parse(a.fecha_cobro) - refMs) -
            Math.abs(Date.parse(b.fecha_cobro) - refMs),
      )
      .slice(0, CANDIDATOS_MAX);
    return {
      movimiento: {
        id: mov.id as string,
        fecha: mov.fecha as string,
        monto: r2(montoMov),
        tipo: mov.tipo as string,
        moneda,
        cobro_id: (mov.cobro_id as string | null) ?? null,
        cobro_grupo_id: (mov.cobro_grupo_id as string | null) ?? null,
      },
      candidatos,
      exactos: candidatos.filter((c) => c.dif_monto === 0).length,
    };
  }

  // =====================================================================
  // PAYWISE (9-sep-2026): universo de cobros por método, cruce y auditoría
  // =====================================================================

  /**
   * Cobros del sistema (cobro_vuelo positivos que NO son parte de sobre +
   * sobres cobro_grupo) con método en `metodos` y fecha_cobro en [lo, hi]
   * (ISO con offset Cancún), normalizados a la forma pura del cruce.
   */
  private async cargarCobrosPorMetodo(
    metodos: readonly string[],
    lo: string,
    hi: string,
    moneda?: string | null,
  ): Promise<CobroPaywise[]> {
    let qc = this.supabase.service
      .from('cobro_vuelo')
      .select(
        'id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, vuelo:vuelo!vuelo_id(folio, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .is('cobro_grupo_id', null)
      .in('metodo_cobro', [...metodos])
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(2000);
    let qs = this.supabase.service
      .from('cobro_grupo')
      .select(
        'id, grupo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, comision_banco_monto, grupo:vuelo_grupo!grupo_id(folio, nombre, cliente:cliente_id(nombre))',
      )
      .gt('monto', 0)
      .in('metodo_cobro', [...metodos])
      .gte('fecha_cobro', lo)
      .lte('fecha_cobro', hi)
      .order('fecha_cobro', { ascending: true })
      .limit(500);
    if (moneda) {
      qc = qc.eq('moneda', moneda);
      qs = qs.eq('moneda', moneda);
    }
    const [cobrosRes, sobresRes] = await Promise.all([qc, qs]);
    if (cobrosRes.error) throw new Error(cobrosRes.error.message);
    if (sobresRes.error) throw new Error(sobresRes.error.message);
    const out: CobroPaywise[] = [];
    for (const c of (cobrosRes.data ?? []) as Array<Record<string, unknown>>) {
      const vuelo = unwrapOne(
        c.vuelo as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(vuelo?.cliente);
      out.push({
        tipo: 'COBRO_VUELO',
        id: c.id as string,
        fecha_cobro: c.fecha_cobro as string,
        monto: r2(Number(c.monto) || 0),
        moneda: (c.moneda as string) ?? 'USD',
        metodo_cobro: (c.metodo_cobro as string | null) ?? null,
        comision_banco_monto:
          Number(c.comision_banco_monto) > 0
            ? r2(Number(c.comision_banco_monto))
            : null,
        referencia: (c.referencia as string | null) ?? null,
        vuelo_id: c.vuelo_id as string,
        folio: vuelo?.folio == null ? null : Number(vuelo.folio),
        grupo_id: null,
        grupo_folio: null,
        cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
      });
    }
    for (const s of (sobresRes.data ?? []) as Array<Record<string, unknown>>) {
      const grupo = unwrapOne(
        s.grupo as {
          folio?: unknown;
          cliente?: { nombre?: unknown } | { nombre?: unknown }[] | null;
        } | null,
      );
      const cliente = unwrapOne(grupo?.cliente);
      out.push({
        tipo: 'SOBRE_GRUPO',
        id: s.id as string,
        fecha_cobro: s.fecha_cobro as string,
        monto: r2(Number(s.monto) || 0),
        moneda: (s.moneda as string) ?? 'USD',
        metodo_cobro: (s.metodo_cobro as string | null) ?? null,
        comision_banco_monto:
          Number(s.comision_banco_monto) > 0
            ? r2(Number(s.comision_banco_monto))
            : null,
        referencia: (s.referencia as string | null) ?? null,
        vuelo_id: null,
        folio: null,
        grupo_id: s.grupo_id as string,
        grupo_folio: grupo?.folio == null ? null : Number(grupo.folio),
        cliente: typeof cliente?.nombre === 'string' ? cliente.nombre : null,
      });
    }
    return out;
  }

  /**
   * Ligas banco↔cobro de estos cobros/sobres (fuente única MOV_LIGA_COLS):
   * mapa cobro (`${tipo}:${id}`) → id del movimiento que lo concilia.
   */
  private async ligasDeCobros(
    cobros: ReadonlyArray<CobroPaywise>,
  ): Promise<Map<string, string>> {
    const filtro = filtroLigaCobros(
      cobros.filter((c) => c.tipo === 'COBRO_VUELO').map((c) => c.id),
      cobros.filter((c) => c.tipo === 'SOBRE_GRUPO').map((c) => c.id),
    );
    const out = new Map<string, string>();
    if (!filtro) return out;
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(MOV_LIGA_COLS)
      .or(filtro);
    if (error) throw new Error(error.message);
    for (const m of (data ?? []) as MovimientoLiga[]) {
      if (typeof m.cobro_id === 'string')
        out.set(`COBRO_VUELO:${m.cobro_id}`, m.id as string);
      if (typeof m.cobro_grupo_id === 'string')
        out.set(`SOBRE_GRUPO:${m.cobro_grupo_id}`, m.id as string);
    }
    return out;
  }

  /**
   * Auto-cruce de UN abono de una cuenta PASARELA (Paywise) recién
   * importado: cobros PAYWISE libres a ±5 días de la MISMA moneda, cotejo
   * NETO → BRUTO (fuente única cruzarPaywise). Liga solo si cuadra el
   * dinero; misma referencia con montos distintos NO se liga sola.
   */
  private async autoMatchAbonoPasarela(
    mov: MovimientoPaywise,
    userId: string,
  ): Promise<ResultadoMovimiento> {
    const base = {
      movimiento_id: mov.id,
      resultado: 'SIN_CANDIDATO' as ResultadoCruce,
      criterio: null as CriterioCruce | null,
      motivo: null as string | null,
      candidatos_n: 0,
    };
    const { lo, hi } = this.ventanaAbono(mov.fecha, PAYWISE_VENTANA_DIAS);
    const cobros = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_PASARELA,
      lo,
      hi,
      mov.moneda,
    );
    const ligas = await this.ligasDeCobros(cobros);
    const libres = cobros.filter((c) => !ligas.has(`${c.tipo}:${c.id}`));
    const r = cruzarPaywise([mov], libres, { dias: PAYWISE_VENTANA_DIAS });
    const cruce = r.coinciden[0];
    if (!cruce) {
      const ambiguos = r.ambiguos?.length ?? 0;
      return {
        ...base,
        resultado: ambiguos > 0 ? 'AMBIGUO' : 'SIN_CANDIDATO',
        candidatos_n: ambiguos,
        motivo:
          ambiguos > 0
            ? `${ambiguos} cobros Paywise cuadran con este depósito: revísalo en la auditoría Paywise.`
            : 'Ningún cobro Paywise libre cuadra con este depósito (neto/bruto/referencia).',
      };
    }
    // La comisión REAL del archivo se escribe ANTES de ligar; un fallo aquí
    // tampoco puede tumbar la importación (se cuenta y se sigue).
    try {
      await this.aplicarCrucePaywise(cruce, userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`auto-match Paywise ${mov.id}: ${msg}`);
      return {
        ...base,
        resultado: err instanceof ConflictException ? 'RECHAZADO' : 'ERROR',
        candidatos_n: 1,
        motivo: msg,
      };
    }
    return {
      ...base,
      resultado: 'CONCILIADO',
      criterio: 'MONTO_EXACTO',
      candidatos_n: 1,
      cobro_id: cruce.cobro.tipo === 'COBRO_VUELO' ? cruce.cobro.id : null,
      cobro_grupo_id:
        cruce.cobro.tipo === 'SOBRE_GRUPO' ? cruce.cobro.id : null,
    };
  }

  /**
   * Aplica un cruce: escribe en el cobro de vuelo la comisión REAL del
   * archivo (si difiere — mismo espíritu que `tc_gasto` al ligar gastos;
   * ANTES de ligar, porque un cobro conciliado ya no se toca) y liga el
   * movimiento (`linkCobro`, con sus candados). Un SOBRE no se reescribe
   * (su comisión se parte entre los hijos): solo se liga y se reporta.
   */
  private async aplicarCrucePaywise(
    cruce: CrucePaywise,
    userId: string,
  ): Promise<void> {
    const { cobro, movimiento } = cruce;
    if (
      cobro.tipo === 'COBRO_VUELO' &&
      cruce.comision_paywise != null &&
      cruce.dif_comision != null &&
      Math.abs(cruce.dif_comision) > 0.01 &&
      cruce.comision_paywise >= 0 &&
      cruce.comision_paywise < cobro.monto
    ) {
      const comision = cruce.comision_paywise;
      const { error } = await this.supabase.service
        .from('cobro_vuelo')
        .update({
          comision_banco_monto: comision > 0 ? r2(comision) : null,
          comision_banco_pct:
            comision > 0
              ? Math.round((comision / cobro.monto) * 100 * 10000) / 10000
              : null,
          updated_by: userId,
        })
        .eq('id', cobro.id);
      if (error) throw new Error(error.message);
      this.logger.log(
        `Paywise: comisión real ${comision} escrita en cobro ${cobro.id} (antes ${cruce.comision_sistema}).`,
      );
    }
    await this.linkCobro(
      movimiento.id,
      cobro.tipo === 'COBRO_VUELO'
        ? { cobro_id: cobro.id }
        : { cobro_grupo_id: cobro.id },
      userId,
    );
  }

  /** Cuentas PASARELA (o la indicada, validando que lo sea). */
  private async cuentasPasarela(cuentaId?: string) {
    let q = this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda, tipo');
    q = cuentaId ? q.eq('id', cuentaId) : q.eq('tipo', TIPO_CUENTA_PASARELA);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const cuentas = (data ?? []) as Array<{
      id: string;
      alias: string;
      banco: string;
      moneda: string;
      tipo: string;
    }>;
    if (cuentaId && cuentas.length === 0)
      throw new NotFoundException(`Cuenta ${cuentaId} not found`);
    if (cuentaId && cuentas[0].tipo !== TIPO_CUENTA_PASARELA) {
      throw new BadRequestException(
        `La cuenta «${cuentas[0].alias}» no es de tipo PASARELA (Paywise).`,
      );
    }
    if (cuentas.length === 0) {
      throw new BadRequestException(
        'No hay ninguna cuenta de tipo PASARELA (Paywise): dala de alta en Cuentas bancarias con tipo PASARELA e importa ahí el estado de cuenta de Paywise.',
      );
    }
    return cuentas;
  }

  /** Suma días a un YYYY-MM-DD (UTC, sin hora). */
  private sumarDias(fecha: string, dias: number): string {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Universo de la auditoría: ABONOS de las cuentas PASARELA en el periodo
   * + cobros PAYWISE del sistema en [desde − días, hasta + días] (cortes
   * Cancún). Los cobros ligados a un movimiento FUERA del universo se
   * excluyen (ya conciliaron en otro periodo) y se cuentan aparte.
   */
  private async universoPaywise(q: PaywiseAuditoriaQuery) {
    const cuentas = await this.cuentasPasarela(q.cuenta_bancaria_id);
    const monedaPorCuenta = new Map(cuentas.map((c) => [c.id, c.moneda]));
    const { data: movsRaw, error } = await this.supabase.service
      .from('movimiento_bancario')
      .select(MOV_COLS)
      .in(
        'cuenta_bancaria_id',
        cuentas.map((c) => c.id),
      )
      .eq('tipo', TipoMovimientoBancario.ABONO)
      .gte('fecha', q.desde)
      .lte('fecha', q.hasta)
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    const movimientos: MovimientoPaywise[] = (
      (movsRaw ?? []) as Array<Record<string, unknown>>
    ).map((m) => ({
      id: m.id as string,
      fecha: m.fecha as string,
      monto: r2(Number(m.monto) || 0),
      monto_bruto: m.monto_bruto == null ? null : r2(Number(m.monto_bruto)),
      comision_monto:
        m.comision_monto == null ? null : r2(Number(m.comision_monto)),
      referencia: (m.referencia as string | null) ?? null,
      descripcion: (m.descripcion as string | null) ?? null,
      moneda: monedaPorCuenta.get(m.cuenta_bancaria_id as string) ?? null,
      cobro_id: (m.cobro_id as string | null) ?? null,
      cobro_grupo_id: (m.cobro_grupo_id as string | null) ?? null,
    }));
    const lo = `${this.sumarDias(q.desde, -q.dias)}T00:00:00-05:00`;
    const hi = `${this.sumarDias(q.hasta, q.dias)}T23:59:59-05:00`;
    const todos = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_PASARELA,
      lo,
      hi,
    );
    const ligas = await this.ligasDeCobros(todos);
    const movIds = new Set(movimientos.map((m) => m.id));
    let cobrosConciliadosFuera = 0;
    const cobros = todos.filter((c) => {
      const movId = ligas.get(`${c.tipo}:${c.id}`);
      if (movId && !movIds.has(movId)) {
        cobrosConciliadosFuera += 1;
        return false;
      }
      return true;
    });
    return { cuentas, movimientos, cobros, cobrosConciliadosFuera };
  }

  private armarSalidaAuditoria(
    q: PaywiseAuditoriaQuery,
    cuentas: Array<{ id: string; alias: string; moneda: string }>,
    movimientos: MovimientoPaywise[],
    cobros: CobroPaywise[],
    cobrosConciliadosFuera: number,
    r: ResultadoCrucePaywise,
    extra: { conciliados_ahora?: number; errores?: unknown[] } = {},
  ) {
    const ya = r.coinciden.filter((c) => c.criterio === 'YA_CONCILIADO');
    const suma = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
    return {
      periodo: { desde: q.desde, hasta: q.hasta },
      dias: q.dias,
      cuentas: cuentas.map((c) => ({
        id: c.id,
        alias: c.alias,
        moneda: c.moneda,
      })),
      resumen: {
        movimientos_paywise: movimientos.length,
        cobros_sistema: cobros.length,
        coinciden: r.coinciden.length,
        ya_conciliados: ya.length,
        conciliables: r.coinciden.length - ya.length,
        comision_distinta: r.comision_distinta.length,
        referencia_monto_distinto: r.referencia_monto_distinto.length,
        solo_paywise: r.solo_paywise.length,
        solo_sistema: r.solo_sistema.length,
        ambiguos: r.ambiguos.length,
        movimientos_conciliados_fuera: r.ya_conciliados_fuera,
        cobros_conciliados_fuera: cobrosConciliadosFuera,
        // Dinero (moneda nativa de la pasarela: MXN).
        neto_paywise: suma(movimientos.map((m) => m.monto)),
        neto_solo_paywise: suma(r.solo_paywise.map((m) => m.monto)),
        bruto_solo_sistema: suma(r.solo_sistema.map((c) => c.monto)),
        dif_comision_total: suma(
          r.comision_distinta.map((c) => c.dif_comision ?? 0),
        ),
        conciliados_ahora: extra.conciliados_ahora ?? 0,
        errores: (extra.errores ?? []).length,
      },
      coinciden: r.coinciden,
      comision_distinta: r.comision_distinta,
      referencia_monto_distinto: r.referencia_monto_distinto,
      solo_paywise: r.solo_paywise,
      solo_sistema: r.solo_sistema,
      ambiguos: r.ambiguos,
      errores: extra.errores ?? [],
    };
  }

  /**
   * GET /conciliacion/paywise/auditoria — SOLO LECTURA. Cruza los abonos
   * importados de Paywise contra los cobros PAYWISE (fecha ±días, NETO →
   * BRUTO → referencia) y devuelve: coinciden (con diferencia de comisión),
   * en Paywise sin cobro, cobros sin Paywise, referencia con monto distinto
   * y ambiguos.
   */
  async auditoriaPaywise(q: PaywiseAuditoriaQuery) {
    if (q.desde > q.hasta)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    const u = await this.universoPaywise(q);
    const r = cruzarPaywise(u.movimientos, u.cobros, { dias: q.dias });
    return this.armarSalidaAuditoria(
      q,
      u.cuentas,
      u.movimientos,
      u.cobros,
      u.cobrosConciliadosFuera,
      r,
    );
  }

  /**
   * POST /conciliacion/paywise/auditoria/conciliar — liga automáticamente
   * los cruces que CUADRAN (NETO/BRUTO), escribiendo la comisión real en los
   * cobros de vuelo, y devuelve la auditoría recalculada. Cada liga es
   * independiente: un fallo (carrera, cobro ya ligado) se reporta en
   * `errores` sin tumbar el resto.
   */
  async conciliarPaywise(q: PaywiseAuditoriaQuery, userId: string) {
    if (q.desde > q.hasta)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    const u = await this.universoPaywise(q);
    const r = cruzarPaywise(u.movimientos, u.cobros, { dias: q.dias });
    let conciliados = 0;
    const errores: Array<{
      movimiento_id: string;
      cobro_id: string;
      tipo: string;
      error: string;
    }> = [];
    for (const cruce of r.coinciden) {
      if (cruce.criterio === 'YA_CONCILIADO') continue;
      try {
        await this.aplicarCrucePaywise(cruce, userId);
        conciliados += 1;
      } catch (err) {
        errores.push({
          movimiento_id: cruce.movimiento.id,
          cobro_id: cruce.cobro.id,
          tipo: cruce.cobro.tipo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const u2 = await this.universoPaywise(q);
    const r2x = cruzarPaywise(u2.movimientos, u2.cobros, { dias: q.dias });
    return this.armarSalidaAuditoria(
      q,
      u2.cuentas,
      u2.movimientos,
      u2.cobros,
      u2.cobrosConciliadosFuera,
      r2x,
      { conciliados_ahora: conciliados, errores },
    );
  }

  /**
   * GET /conciliacion/paywise/auditoria.xlsx — 3 hojas: «Cotejo» (todo lo
   * cruzado con bruto/comisión/neto sistema vs Paywise y la diferencia en
   * naranja), «Paywise sin cobro» y «Cobros sin Paywise».
   */
  async auditoriaPaywiseXlsx(
    q: PaywiseAuditoriaQuery,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    const a = await this.auditoriaPaywise(q);
    const quien = (c: CobroPaywise) =>
      c.tipo === 'SOBRE_GRUPO'
        ? `Grupo G-${c.grupo_folio ?? '?'}`
        : `Vuelo #${c.folio ?? '?'}`;
    const criterioLabel: Record<string, string> = {
      YA_CONCILIADO: 'Ya conciliado',
      NETO: 'Neto exacto',
      BRUTO: 'Bruto exacto',
      REFERENCIA: 'Referencia (monto distinto)',
    };
    // Cotejo: coinciden + referencia con monto distinto + ambiguos.
    const cotejoFilas: (string | number | null)[][] = [];
    const cotejoResaltes: { fila: number; col: number }[] = [];
    const filaCruce = (c: CrucePaywise, estatus: string) => {
      const i = cotejoFilas.length;
      cotejoFilas.push([
        c.movimiento.fecha,
        c.movimiento.referencia ?? '',
        quien(c.cobro),
        c.cobro.cliente ?? '',
        diaCancun(c.cobro.fecha_cobro),
        c.cobro.monto,
        c.movimiento.monto_bruto ?? null,
        c.comision_sistema,
        c.comision_paywise,
        c.neto_sistema,
        c.movimiento.monto,
        c.dif_comision,
        criterioLabel[c.criterio] ?? c.criterio,
        estatus,
      ]);
      if (c.comision_distinta) {
        cotejoResaltes.push({ fila: i, col: 11 });
        cotejoResaltes.push({ fila: i, col: 8 });
      }
      if (c.criterio === 'REFERENCIA') {
        cotejoResaltes.push({ fila: i, col: 10 });
        cotejoResaltes.push({ fila: i, col: 13 });
      }
    };
    for (const c of a.coinciden) {
      filaCruce(
        c,
        c.criterio === 'YA_CONCILIADO'
          ? c.comision_distinta
            ? 'Conciliado · comisión distinta'
            : 'Conciliado'
          : c.comision_distinta
            ? 'Cuadra · comisión distinta'
            : 'Cuadra',
      );
    }
    for (const c of a.referencia_monto_distinto) {
      filaCruce(c, 'REVISAR: misma referencia, monto distinto');
    }
    for (const amb of a.ambiguos) {
      const i = cotejoFilas.length;
      cotejoFilas.push([
        amb.movimiento.fecha,
        amb.movimiento.referencia ?? '',
        amb.candidatos.map(quien).join(' / '),
        '',
        '',
        null,
        amb.movimiento.monto_bruto ?? null,
        null,
        amb.movimiento.comision_monto ?? null,
        null,
        amb.movimiento.monto,
        null,
        criterioLabel[amb.criterio] ?? amb.criterio,
        `AMBIGUO: ${amb.candidatos.length} cobros iguales — concilia a mano`,
      ]);
      cotejoResaltes.push({ fila: i, col: 13 });
    }
    const money = (label: string) => ({ label, tipo: 'money' as const });
    const texto = (label: string) => ({ label, tipo: 'texto' as const });
    const moneda = a.cuentas[0]?.moneda ?? 'MXN';
    const sinCobroFilas = a.solo_paywise.map((m) => [
      m.fecha,
      m.referencia ?? '',
      m.descripcion ?? '',
      m.monto_bruto ?? null,
      m.comision_monto ?? null,
      m.monto,
    ]);
    const sinPaywiseFilas = a.solo_sistema.map((c) => [
      diaCancun(c.fecha_cobro),
      quien(c),
      c.cliente ?? '',
      c.referencia ?? '',
      c.monto,
      c.comision_banco_monto ?? 0,
      r2(c.monto - (c.comision_banco_monto ?? 0)),
      c.moneda,
    ]);
    const s = a.resumen;
    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: 'Auditoría Paywise',
      subtitulo: `${q.desde} a ${q.hasta}`,
      columnas: [texto('Resumen')],
      filas: [],
      hojas: [
        {
          titulo: 'Cotejo',
          subtitulo: `${s.movimientos_paywise} abonos Paywise · ${s.cobros_sistema} cobros Paywise en el sistema · ${s.coinciden} coinciden (${s.ya_conciliados} ya conciliados) · ${s.comision_distinta} con comisión distinta · ${s.referencia_monto_distinto} referencia/monto · ${s.ambiguos} ambiguos · ±${q.dias} días · ${q.desde} a ${q.hasta}`,
          columnas: [
            texto('Fecha Paywise'),
            texto('Referencia'),
            texto('Vuelo / Grupo'),
            texto('Cliente'),
            texto('Fecha cobro'),
            money(`Bruto sistema (${moneda})`),
            money('Bruto Paywise'),
            money('Comisión sistema'),
            money('Comisión Paywise'),
            money('Neto sistema'),
            money('Neto Paywise (abono)'),
            money('Dif. comisión'),
            texto('Criterio'),
            texto('Estatus'),
          ],
          filas: cotejoFilas,
          resaltes: cotejoResaltes,
          totales: [
            'Totales',
            null,
            null,
            null,
            null,
            r2(a.coinciden.reduce((x, c) => x + c.cobro.monto, 0)),
            r2(
              a.coinciden.reduce(
                (x, c) => x + (c.movimiento.monto_bruto ?? 0),
                0,
              ),
            ),
            r2(a.coinciden.reduce((x, c) => x + c.comision_sistema, 0)),
            r2(a.coinciden.reduce((x, c) => x + (c.comision_paywise ?? 0), 0)),
            r2(a.coinciden.reduce((x, c) => x + c.neto_sistema, 0)),
            r2(a.coinciden.reduce((x, c) => x + c.movimiento.monto, 0)),
            s.dif_comision_total,
            null,
            null,
          ],
        },
        {
          titulo: 'Paywise sin cobro',
          subtitulo: `${s.solo_paywise} abonos de Paywise sin cobro registrado en el sistema (neto ${s.neto_solo_paywise} ${moneda}) · ${q.desde} a ${q.hasta}`,
          columnas: [
            texto('Fecha'),
            texto('Referencia'),
            texto('Descripción'),
            money('Bruto'),
            money('Comisión'),
            money(`Neto (${moneda})`),
          ],
          filas: sinCobroFilas,
          resaltes: sinCobroFilas.map((_, i) => ({ fila: i, col: 5 })),
          totales: [
            'Totales',
            null,
            null,
            r2(a.solo_paywise.reduce((x, m) => x + (m.monto_bruto ?? 0), 0)),
            r2(a.solo_paywise.reduce((x, m) => x + (m.comision_monto ?? 0), 0)),
            s.neto_solo_paywise,
          ],
        },
        {
          titulo: 'Cobros sin Paywise',
          subtitulo: `${s.solo_sistema} cobros con método Paywise sin abono en el estado de cuenta (bruto ${s.bruto_solo_sistema}) · cobros de ${this.sumarDias(q.desde, -q.dias)} a ${this.sumarDias(q.hasta, q.dias)}`,
          columnas: [
            texto('Fecha cobro'),
            texto('Vuelo / Grupo'),
            texto('Cliente'),
            texto('Referencia'),
            money('Bruto'),
            money('Comisión registrada'),
            money('Neto esperado'),
            texto('Moneda'),
          ],
          filas: sinPaywiseFilas,
          resaltes: sinPaywiseFilas.map((_, i) => ({ fila: i, col: 4 })),
          totales: [
            'Totales',
            null,
            null,
            null,
            s.bruto_solo_sistema,
            r2(
              a.solo_sistema.reduce(
                (x, c) => x + (c.comision_banco_monto ?? 0),
                0,
              ),
            ),
            r2(
              a.solo_sistema.reduce(
                (x, c) => x + c.monto - (c.comision_banco_monto ?? 0),
                0,
              ),
            ),
            null,
          ],
        },
      ],
    });
    return { buffer, etiqueta: 'paywise' };
  }

  /**
   * GET /conciliacion/cobros-sin-banco — el espejo de `gastosSinBanco` para
   * los COBROS (9-sep-2026): cobros de vuelo (no partes de sobre) y sobres
   * con método bancario (transferencia / HSBC link / cheque / Paywise) sin
   * liga con ningún abono importado. Lo usa el pre-cierre como aviso.
   * Default: últimos 90 días por fecha_cobro (cortes Cancún).
   */
  async cobrosSinBanco(desde?: string, hasta?: string) {
    // Defaults en día CANCÚN (no UTC): a las 20:00 de Cancún el UTC ya es
    // mañana y el corte se corría un día.
    const d = desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    const h = hasta ?? hoyCancun();
    if (d > h)
      throw new BadRequestException('desde no puede ser posterior a hasta');
    const cobros = await this.cargarCobrosPorMetodo(
      METODOS_COBRO_ABONO_AUTO,
      `${d}T00:00:00-05:00`,
      `${h}T23:59:59-05:00`,
    );
    const ligas = await this.ligasDeCobros(cobros);
    const libres = cobros.filter((c) => !ligas.has(`${c.tipo}:${c.id}`));
    const porMoneda = new Map<string, number>();
    const data = libres.map((c) => {
      porMoneda.set(c.moneda, (porMoneda.get(c.moneda) ?? 0) + c.monto);
      return {
        ...c,
        metodo_label: etiquetaMetodoCobro(c.metodo_cobro),
        neto: r2(c.monto - (c.comision_banco_monto ?? 0)),
      };
    });
    return {
      data,
      total: data.length,
      desde: d,
      hasta: h,
      por_moneda: [...porMoneda.entries()].map(([moneda, monto]) => ({
        moneda,
        monto: r2(monto),
      })),
    };
  }

  /** Catálogo de clasificaciones "sin vuelo" (activas, orden alfabético). */
  async listClasificaciones() {
    const { data, error } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .select('id, nombre, activo')
      .eq('activo', true)
      .order('nombre', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  /**
   * Crea una clasificación (o devuelve la existente si el nombre ya está,
   * sin distinguir mayúsculas): el diálogo del panel crea "en el mismo
   * espacio" y no debe fallar por un duplicado de dedo.
   */
  async crearClasificacion(nombre: string, userId: string) {
    const limpio = nombre.trim().replace(/\s+/g, ' ');
    if (limpio.length < 2) {
      throw new BadRequestException(
        'El nombre de la clasificación es muy corto.',
      );
    }
    const { data: existente, error: exErr } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .select('id, nombre, activo')
      .ilike('nombre', limpio)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (existente) return existente;
    const { data, error } = await this.supabase.service
      .from('conciliacion_clasificacion')
      .insert({ nombre: limpio, created_by: userId })
      .select('id, nombre, activo')
      .maybeSingle();
    if (error) {
      // Carrera con el índice único lower(nombre): devuelve la ganadora.
      if (error.code === '23505') {
        const { data: otra } = await this.supabase.service
          .from('conciliacion_clasificacion')
          .select('id, nombre, activo')
          .ilike('nombre', limpio)
          .maybeSingle();
        if (otra) return otra;
      }
      throw new Error(error.message);
    }
    return data!;
  }

  /**
   * Concilia un movimiento por CLASIFICACIÓN (no corresponde a ningún
   * gasto/cobro de vuelo: comisión del banco, impuestos, personal…), con
   * notas opcionales. clasificacion_id null la quita y el movimiento vuelve
   * a Pendiente. Excluyente con gasto/cobro vinculado.
   */
  async clasificarMovimiento(
    movId: string,
    clasificacionId: string | null,
    notas: string | undefined,
    userId: string,
  ) {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id, cobro_id, cobro_grupo_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);
    if (
      clasificacionId &&
      (mov.gasto_id || mov.cobro_id || mov.cobro_grupo_id)
    ) {
      throw new ConflictException(
        'El movimiento ya está conciliado con un gasto/cobro: desvincúlalo antes de clasificarlo.',
      );
    }
    if (clasificacionId) {
      const { data: clasif, error: clErr } = await this.supabase.service
        .from('conciliacion_clasificacion')
        .select('id')
        .eq('id', clasificacionId)
        .maybeSingle();
      if (clErr) throw new Error(clErr.message);
      if (!clasif)
        throw new BadRequestException('Clasificación no encontrada.');
    }
    const patch: Record<string, unknown> = {
      clasificacion_id: clasificacionId,
      // Clasificar CONCILIA (deja de estar Pendiente); quitarla lo regresa.
      conciliado: clasificacionId !== null,
      updated_by: userId,
    };
    if (notas !== undefined) patch.notas = notas.trim() || null;
    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update(patch)
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data!;
  }

  /**
   * Resumen por cuenta para el cierre: cuántos movimientos hay, cuántos están
   * conciliados y cuánto dinero sigue pendiente. "Faltan N por conciliar" deja
   * de descubrirse revisando la lista a mano.
   */
  /**
   * El INVERSO de la bandeja de movimientos (28-ago, pedido del cliente):
   * gastos pagados por BANCO (tarjeta corporativa / transferencia / PayWise)
   * que no
   * cruzaron con ninguna línea de los estados de cuenta importados. Motivos
   * típicos: el periodo del banco aún no se importa, la fecha/monto del
   * gasto no coincide, o el cargo nunca llegó al banco. Default: últimos
   * 90 días por fecha_gasto (DATE, sin componente horaria).
   */
  /**
   * Suma de |monto| de los cargos del banco ligados a cada gasto (pagos
   * parciales, 14-sep-2026). Devuelve solo los gastos CON algún cargo; los
   * demás valen 0. Se consulta por lotes (`in`) para no disparar una
   * consulta por fila.
   */
  private async sumasLigadasDe(
    gastoIds: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ids = [...new Set(gastoIds.filter(Boolean))];
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await this.supabase.service
        .from('movimiento_bancario')
        .select('gasto_id, monto')
        .in('gasto_id', ids.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const m of data ?? []) {
        const gid = m.gasto_id as string | null;
        if (!gid) continue;
        out.set(
          gid,
          r2((out.get(gid) ?? 0) + (Math.abs(Number(m.monto)) || 0)),
        );
      }
    }
    return out;
  }

  async gastosSinBanco(desde?: string, hasta?: string) {
    // Default en día CANCÚN (no UTC), igual que `cobrosSinBanco`: a las
    // 20:00 de Cancún el UTC ya es mañana y el corte se corría un día
    // (invariante 4).
    const d = desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    let q = this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, categoria, monto, moneda, tc_gasto, medio_pago, tarjeta_terminacion, lugar, conciliado, proveedor:proveedor!proveedor_id(nombre), captura:usuario!usuario_captura_id(nombre), vuelo:vuelo!vuelo_id(folio)',
        { count: 'exact' },
      )
      .in('medio_pago', MEDIOS_BANCARIOS)
      .eq('conciliado', false)
      .gte('fecha_gasto', d)
      .order('fecha_gasto', { ascending: false })
      .limit(500);
    if (hasta) q = q.lte('fecha_gasto', hasta);
    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    // Pagos PARCIALES (14-sep-2026): un gasto sigue aquí mientras la suma de
    // sus cargos no lo cubra — con lo ya vinculado y lo que falta, para que
    // la oficina no lo lea como "sin nada del banco".
    const vinculado = await this.sumasLigadasDe(
      rows.map((g) => g.id as string),
    );
    // Totales por moneda NATIVA (jamás convertir aquí: es un listado de
    // faltantes, no un balance).
    const porMoneda = new Map<string, number>();
    for (const g of rows) {
      const mon = (g.moneda as string) ?? 'MXN';
      porMoneda.set(mon, (porMoneda.get(mon) ?? 0) + Number(g.monto));
      const suma = vinculado.get(g.id as string) ?? 0;
      g.monto_vinculado = suma;
      g.faltante = faltanteDe(Number(g.monto), suma);
      g.parcial = suma > 0;
    }
    return {
      data: rows,
      total: count ?? rows.length,
      desde: d,
      hasta: hasta ?? null,
      por_moneda: [...porMoneda.entries()].map(([moneda, monto]) => ({
        moneda,
        monto: Math.round(monto * 100) / 100,
      })),
    };
  }

  async resumen(desde?: string, hasta?: string) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select('cuenta_bancaria_id, tipo, monto, conciliado');
    if (desde) q = q.gte('fecha', desde);
    if (hasta) q = q.lte('fecha', hasta);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const { data: cuentas } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda');
    const cuentaInfo = new Map(
      (cuentas ?? []).map((c) => [
        c.id as string,
        c as Record<string, unknown>,
      ]),
    );

    const porCuenta = new Map<
      string,
      {
        total: number;
        conciliados: number;
        pendientes: number;
        monto_pendiente: number;
      }
    >();
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      const key = m.cuenta_bancaria_id as string;
      const cur = porCuenta.get(key) ?? {
        total: 0,
        conciliados: 0,
        pendientes: 0,
        monto_pendiente: 0,
      };
      cur.total += 1;
      if (m.conciliado === true) cur.conciliados += 1;
      else {
        cur.pendientes += 1;
        cur.monto_pendiente += Number(m.monto);
      }
      porCuenta.set(key, cur);
    }

    return [...porCuenta.entries()].map(([id, v]) => {
      const info = cuentaInfo.get(id);
      return {
        cuenta_bancaria_id: id,
        alias: (info?.alias as string) ?? null,
        banco: (info?.banco as string) ?? null,
        moneda: (info?.moneda as string) ?? null,
        total: v.total,
        conciliados: v.conciliados,
        pendientes: v.pendientes,
        monto_pendiente: Math.round(v.monto_pendiente * 100) / 100,
      };
    });
  }

  /**
   * Reporte de conciliación en Excel: réplica del estado de cuenta (una fila
   * por movimiento, cargos y abonos en columnas) con el ESTATUS de cada línea
   * (Conciliado/PENDIENTE), la MATRÍCULA del avión de la línea y con qué se
   * cruzó (gasto o cobro, con su vuelo). Los montos SIN conciliar van
   * resaltados en naranja. `estado` refleja las 4 pestañas de la página;
   * `sin_banco` cambia de universo (gastos bancarios que no aparecen en el
   * banco) y ahí la cuenta bancaria se IGNORA.
   */
  async reporteXlsx(
    cuentaBancariaId: string | undefined,
    desde: string,
    hasta: string,
    estado: ReporteConciliacionEstado = 'todos',
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    if (estado === 'sin_banco') {
      return this.reporteGastosSinBancoXlsx(desde, hasta);
    }
    if (!cuentaBancariaId) {
      throw new BadRequestException(
        'cuenta_bancaria_id es requerida (salvo estado=sin_banco).',
      );
    }
    const { data: cuenta, error: ctaErr } = await this.supabase.service
      .from('cuenta_bancaria')
      .select('id, alias, banco, moneda')
      .eq('id', cuentaBancariaId)
      .maybeSingle();
    if (ctaErr) throw new Error(ctaErr.message);
    if (!cuenta)
      throw new NotFoundException(`Cuenta ${cuentaBancariaId} not found`);

    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // escala_id/aeronave_id del gasto y aeronave_id de los vuelos: para
        // resolver la MATRÍCULA de la línea (avionDelGasto, fuente única).
        `${MOV_COLS}, gasto:gasto!gasto_id(categoria, vuelo_id, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id)), cobro:cobro_vuelo!cobro_id(metodo_cobro, vuelo:vuelo!vuelo_id(folio, aeronave_id)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
      )
      .eq('cuenta_bancaria_id', cuentaBancariaId)
      // `fecha` es DATE-only: se compara con YYYY-MM-DD a secas.
      .gte('fecha', desde)
      .lte('fecha', hasta)
      // Orden del estado de cuenta impreso: cronológico ascendente.
      .order('fecha', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(5000);
    // Filtro de estado (mismas pestañas del panel). En movimiento_bancario
    // "pendiente" y "no conciliado" son el MISMO booleano.
    if (estado === 'pendientes') q = q.eq('conciliado', false);
    if (estado === 'conciliados') q = q.eq('conciliado', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    // Sobres de grupo normalizados (SOBRE_GRUPO con aviones_n).
    const movs = await this.normalizarSobresEnMovs(data ?? []);

    // Mapas para la matrícula: repartos manuales de los gastos ligados y
    // aeronave/escala (patrón del Libro Dinero; la herencia escala→vuelo la
    // aplica avionDelGasto).
    const [repartos, mapas] = await Promise.all([
      fetchRepartos(
        this.supabase.service,
        movs
          .map((m) => m.gasto_id as string | null)
          .filter((id): id is string => !!id),
      ),
      this.cargarMapasAvion(
        movs
          .map(
            (m) =>
              unwrapOne(m.gasto as { escala_id?: string | null } | null)
                ?.escala_id ?? null,
          )
          .filter((id): id is string => !!id),
      ),
    ]);

    const matriculaDeMov = (m: Record<string, unknown>): string => {
      const gasto = unwrapOne(
        m.gasto as {
          escala_id?: string | null;
          aeronave_id?: string | null;
          vuelo?:
            | { aeronave_id?: string | null }
            | { aeronave_id?: string | null }[]
            | null;
        } | null,
      );
      if (gasto) {
        return this.matriculaDeGasto(
          m.gasto_id as string | null,
          gasto,
          unwrapOne(gasto.vuelo)?.aeronave_id ?? null,
          repartos,
          mapas,
        );
      }
      // SOBRE de grupo: el pago cubre N aviones (no hay UNA matrícula).
      const sobre = m.cobro_grupo as SobreConciliacion | null;
      if (sobre) {
        return sobre.aviones_n > 0
          ? `${sobre.aviones_n} avión${sobre.aviones_n === 1 ? '' : 'es'}`
          : '';
      }
      // Línea de COBRO: el avión (principal) de su vuelo.
      const cobro = unwrapOne(
        m.cobro as {
          vuelo?:
            | { aeronave_id?: string | null }
            | { aeronave_id?: string | null }[]
            | null;
        } | null,
      );
      const avionId = unwrapOne(cobro?.vuelo)?.aeronave_id ?? null;
      return avionId ? (mapas.matriculas.get(avionId) ?? '') : '';
    };

    const conQue = (m: Record<string, unknown>): string => {
      const gasto = unwrapOne(
        m.gasto as {
          categoria?: string;
          proveedor?: { nombre?: string } | { nombre?: string }[] | null;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (gasto) {
        const prov = unwrapOne(gasto.proveedor)?.nombre;
        const folio = unwrapOne(gasto.vuelo)?.folio;
        // "Gasto Comida"; una etiqueta que ya empieza con "Gasto…" no se
        // duplica (fuente única categoria-gasto.util).
        const etiquetaCat = etiquetaCategoriaGasto(gasto.categoria);
        return [
          /^gasto/i.test(etiquetaCat)
            ? etiquetaCat
            : `Gasto ${etiquetaCat}`.trim(),
          prov ?? null,
          folio != null ? `vuelo #${folio}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      const sobre = m.cobro_grupo as SobreConciliacion | null;
      if (sobre) {
        return `Cobro grupo G-${sobre.grupo_folio ?? '?'} · ${etiquetaMetodoCobro(sobre.metodo)}`;
      }
      const cobro = unwrapOne(
        m.cobro as {
          metodo_cobro?: string;
          vuelo?: { folio?: number } | { folio?: number }[] | null;
        } | null,
      );
      if (cobro) {
        const folio = unwrapOne(cobro.vuelo)?.folio;
        return [
          'Cobro',
          folio != null ? `vuelo #${folio}` : null,
          cobro.metodo_cobro ? etiquetaMetodoCobro(cobro.metodo_cobro) : null,
        ]
          .filter(Boolean)
          .join(' · ');
      }
      const clasif = unwrapOne(m.clasificacion as { nombre?: string } | null);
      if (clasif?.nombre) return `Clasificación: ${clasif.nombre}`;
      return '';
    };

    let totalCargos = 0;
    let totalAbonos = 0;
    let conciliados = 0;
    // Montos SIN conciliar en NARANJA: celda de Cargo o Abono según cuál
    // tenga valor (índices 0-based NUEVOS tras insertar Matrícula: Cargo=4,
    // Abono=5).
    const resaltes: { fila: number; col: number }[] = [];
    const filas = movs.map((m, i) => {
      const monto = Number(m.monto) || 0;
      const esCargo = m.tipo === 'CARGO';
      if (esCargo) totalCargos += monto;
      else totalAbonos += monto;
      const ok = m.conciliado === true;
      if (ok) conciliados += 1;
      else resaltes.push({ fila: i, col: esCargo ? 4 : 5 });
      return [
        (m.fecha as string) ?? '',
        (m.descripcion as string | null) ?? '',
        (m.referencia as string | null) ?? '',
        matriculaDeMov(m),
        esCargo ? monto : null,
        esCargo ? null : monto,
        ok ? 'Conciliado' : 'PENDIENTE',
        ok ? conQue(m) : '',
        (m.notas as string | null) ?? '',
      ];
    });

    const pendientes = movs.length - conciliados;
    const etiquetaCuenta = `${cuenta.alias as string} · ${cuenta.banco as string} (${cuenta.moneda as string})`;
    const etiquetaEstado = {
      todos: 'todos',
      pendientes: 'solo pendientes',
      conciliados: 'solo conciliados',
    }[estado];
    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: `Conciliación · ${etiquetaCuenta}`,
      subtitulo: `${movs.length} movimientos (${etiquetaEstado}) · ${conciliados} conciliados · ${pendientes} pendientes · ${desde} a ${hasta}`,
      columnas: [
        { label: 'Fecha', tipo: 'texto' },
        { label: 'Descripción', tipo: 'texto' },
        { label: 'Referencia', tipo: 'texto' },
        { label: 'Matrícula', tipo: 'texto' },
        { label: `Cargo (${cuenta.moneda as string})`, tipo: 'money' },
        { label: `Abono (${cuenta.moneda as string})`, tipo: 'money' },
        { label: 'Estatus', tipo: 'texto' },
        { label: 'Conciliado con', tipo: 'texto' },
        { label: 'Notas', tipo: 'texto' },
      ],
      filas,
      totales: [
        'Totales',
        null,
        null,
        null,
        Number(totalCargos.toFixed(2)),
        Number(totalAbonos.toFixed(2)),
        `${conciliados} conciliados`,
        `${pendientes} pendientes`,
        null,
      ],
      resaltes,
    });
    return { buffer, etiqueta: (cuenta.alias as string) ?? 'cuenta' };
  }

  /**
   * Rama estado=sin_banco del reporte (los "no conciliados" del cliente):
   * gastos BANCARIOS (tarjeta corporativa / transferencia / PayWise) que NO
   * cruzaron
   * con ninguna línea del banco — MISMO criterio que gastosSinBanco, pero
   * con el rango desde/hasta obligatorio sobre fecha_gasto (sin el cap de
   * 90 días). Aquí TODO está sin conciliar: todos los montos van en naranja.
   */
  private async reporteGastosSinBancoXlsx(
    desde: string,
    hasta: string,
  ): Promise<{ buffer: Buffer; etiqueta: string }> {
    const { data, error } = await this.supabase.service
      .from('gasto')
      .select(
        'id, fecha_gasto, categoria, monto, moneda, medio_pago, tarjeta_terminacion, lugar, escala_id, aeronave_id, proveedor:proveedor!proveedor_id(nombre), captura:usuario!usuario_captura_id(nombre), vuelo:vuelo!vuelo_id(folio, aeronave_id)',
      )
      .in('medio_pago', MEDIOS_BANCARIOS)
      .eq('conciliado', false)
      // fecha_gasto es DATE: comparación de días, sin componente horaria.
      .gte('fecha_gasto', desde)
      .lte('fecha_gasto', hasta)
      .order('fecha_gasto', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    const unwrapOne = <T>(v: T | T[] | null | undefined): T | null =>
      Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

    const [repartos, mapas, vinculado] = await Promise.all([
      fetchRepartos(
        this.supabase.service,
        rows.map((g) => g.id as string),
      ),
      this.cargarMapasAvion(
        rows
          .map((g) => g.escala_id as string | null)
          .filter((id): id is string => !!id),
      ),
      // Pagos PARCIALES (14-sep-2026): cuánto del gasto ya cruzó con el banco.
      this.sumasLigadasDe(rows.map((g) => g.id as string)),
    ]);

    // Totales por moneda NATIVA (jamás convertir aquí: es un listado de
    // faltantes, no un balance — misma regla que la pestaña del panel).
    const porMoneda = new Map<string, number>();
    const filas = rows.map((g) => {
      const monto = Number(g.monto) || 0;
      const mon = (g.moneda as string | null) ?? 'MXN';
      porMoneda.set(mon, (porMoneda.get(mon) ?? 0) + monto);
      const vuelo = unwrapOne(
        g.vuelo as { folio?: number; aeronave_id?: string | null } | null,
      );
      return [
        (g.fecha_gasto as string) ?? '',
        (g.categoria as string | null) ?? '',
        unwrapOne(g.proveedor as { nombre?: string } | null)?.nombre ??
          (g.lugar as string | null) ??
          '',
        g.medio_pago === 'TARJETA_CORP'
          ? `Tarjeta${g.tarjeta_terminacion ? ` **** ${g.tarjeta_terminacion as string}` : ''}`
          : g.medio_pago === 'PAYWISE'
            ? 'PayWise'
            : 'Transferencia',
        unwrapOne(g.captura as { nombre?: string } | null)?.nombre ?? '',
        vuelo?.folio != null ? `#${vuelo.folio}` : '',
        this.matriculaDeGasto(
          g.id as string,
          {
            escala_id: (g.escala_id as string | null) ?? null,
            aeronave_id: (g.aeronave_id as string | null) ?? null,
          },
          vuelo?.aeronave_id ?? null,
          repartos,
          mapas,
        ),
        monto,
        mon,
        // «Parcial»: el gasto ya trae cargos del banco pero no lo cubren.
        (() => {
          const ligado = vinculado.get(g.id as string) ?? 0;
          if (!(ligado > 0)) return '';
          return `parcial · faltan ${montoBonito(faltanteDe(monto, ligado))} de ${montoBonito(monto)}`;
        })(),
      ];
    });

    const buffer = await this.pyservices.generateTablaXlsx({
      titulo: 'Conciliación · Gastos sin banco',
      subtitulo: `${rows.length} gastos bancarios (tarjeta/transferencia/PayWise) sin cruzar con el banco · ${desde} a ${hasta}`,
      columnas: [
        { label: 'Fecha', tipo: 'texto' },
        { label: 'Categoría', tipo: 'texto' },
        { label: 'Proveedor', tipo: 'texto' },
        { label: 'Medio', tipo: 'texto' },
        { label: 'Capturó', tipo: 'texto' },
        { label: 'Vuelo', tipo: 'texto' },
        { label: 'Matrícula', tipo: 'texto' },
        { label: 'Monto', tipo: 'money' },
        { label: 'Moneda', tipo: 'texto' },
        // Aditiva y AL FINAL: el resalte naranja apunta a la col 7 (Monto).
        { label: 'Parcial', tipo: 'texto' },
      ],
      filas,
      // Nada de esta pestaña está conciliado: TODOS los montos en naranja
      // (col 7 = Monto, 0-based).
      resaltes: filas.map((_, i) => ({ fila: i, col: 7 })),
      resumen_titulo: 'Total sin conciliar por moneda',
      resumen: [...porMoneda.entries()].map(([moneda, monto]) => [
        moneda,
        Math.round(monto * 100) / 100,
      ]),
    });
    // El controller añade "-sin-banco": el archivo queda
    // "conciliacion-gastos-sin-banco-<desde>-a-<hasta>.xlsx".
    return { buffer, etiqueta: 'gastos' };
  }

  /**
   * Matrícula de un GASTO para reportes: si tiene reparto manual, el reparto
   * GANA (unión de matrículas con «+»; el remanente es de la empresa, sin
   * matrícula); si no, avionDelGasto (fuente única: escala CON herencia →
   * gasto → vuelo).
   */
  private matriculaDeGasto(
    gastoId: string | null | undefined,
    gasto: { escala_id?: string | null; aeronave_id?: string | null },
    vueloAeronaveId: string | null | undefined,
    repartos: Map<string, GastoRepartoFila[]>,
    mapas: {
      matriculas: Map<string, string>;
      escalaPorId: Map<string, { aeronave_id: string | null }>;
    },
  ): string {
    const filasReparto = gastoId ? repartos.get(gastoId) : undefined;
    if (filasReparto && filasReparto.length > 0) {
      const mats = [
        ...new Set(
          filasReparto
            .map((f) => mapas.matriculas.get(f.aeronave_id))
            .filter((x): x is string => !!x),
        ),
      ];
      return mats.join(' + ');
    }
    const avionId = avionDelGasto(gasto, mapas.escalaPorId, vueloAeronaveId);
    return avionId ? (mapas.matriculas.get(avionId) ?? '') : '';
  }

  /**
   * Mapas para resolver matrículas: aeronave id→matrícula (toda la flota) y
   * escala id→avión CRUDO. El mapa de escalas incluye TAMBIÉN las canceladas
   * (un gasto de un tramo cancelado sigue siendo de ese avión); la herencia
   * escala→vuelo la aplica avionDelGasto, no este loader.
   */
  private async cargarMapasAvion(escalaIds: string[]): Promise<{
    matriculas: Map<string, string>;
    escalaPorId: Map<string, { aeronave_id: string | null }>;
  }> {
    const { data: aviones, error: avErr } = await this.supabase.service
      .from('aeronave')
      .select('id, matricula');
    if (avErr) throw new Error(avErr.message);
    const matriculas = new Map(
      (aviones ?? []).map((a) => [a.id as string, a.matricula as string]),
    );
    const escalaPorId = new Map<string, { aeronave_id: string | null }>();
    const unicos = [...new Set(escalaIds)];
    const CHUNK = 200;
    for (let i = 0; i < unicos.length; i += CHUNK) {
      const { data, error } = await this.supabase.service
        .from('escala')
        .select('id, aeronave_id')
        .in('id', unicos.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
      for (const e of data ?? []) {
        escalaPorId.set(e.id as string, {
          aeronave_id: (e.aeronave_id as string | null) ?? null,
        });
      }
    }
    return { matriculas, escalaPorId };
  }

  async list(filters: ListConciliacionQuery) {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        // El gasto/cobro conciliado trae su detalle y su vuelo (folio) para
        // que la fila sea verificable de un clic desde el panel.
        `${MOV_COLS}, gasto:gasto!gasto_id(id, monto, moneda, categoria, fecha_gasto, vuelo_id, proveedor:proveedor!proveedor_id(nombre), vuelo:vuelo!vuelo_id(folio)), cobro:cobro_vuelo!cobro_id(monto, moneda, metodo_cobro, fecha_cobro, vuelo_id, vuelo:vuelo!vuelo_id(folio)), ${SOBRE_EMBED}, clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`,
        { count: 'exact' },
      )
      .order('fecha', { ascending: false })
      .order('created_at', { ascending: false })
      .range(filters.offset, filters.offset + filters.limit - 1);
    if (filters.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', filters.cuenta_bancaria_id);
    if (typeof filters.conciliado === 'boolean')
      q = q.eq('conciliado', filters.conciliado);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    const filas = await this.normalizarSobresEnMovs(data ?? []);
    await this.anotarMotivoPendiente(filas);
    return {
      // `cobro_grupo` (aditivo): sobre de grupo conciliado, forma SOBRE_GRUPO.
      data: filas,
      count: count ?? 0,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * POR QUÉ sigue pendiente cada CARGO de la página (15-sep-2026). Es la
   * pregunta literal del cliente («salen como pendiente»): el badge ámbar a
   * secas no dice nada y obligaba a abrir uno por uno.
   *
   * Campos ADITIVOS `motivo_pendiente` ∈ {SIN_CANDIDATOS, AMBIGUO,
   * SE_PUEDE_CRUZAR} y `candidatos_n`, calculados con las MISMAS reglas del
   * auto-cruce (`elegirCandidato`) en DOS consultas en lote para toda la
   * página — nunca una por fila.
   *
   * HONESTIDAD ANTES QUE COBERTURA: si algo falla o la consulta de gastos se
   * trunca, NO se anota nada (la UI vuelve al badge «Pendiente» de siempre).
   * Un «Sin candidato» falso sería peor que no decir nada. Los ABONOS no se
   * anotan: su universo son cobros y sobres, y ahí no hay consulta en lote.
   */
  private async anotarMotivoPendiente(
    filas: Array<Record<string, unknown>>,
  ): Promise<void> {
    const pendientes = filas.filter(
      (m) =>
        m.conciliado === false &&
        m.tipo === (TipoMovimientoBancario.CARGO as string) &&
        typeof m.fecha === 'string',
    );
    if (pendientes.length === 0) return;
    try {
      const cuentaIds = [
        ...new Set(
          pendientes
            .map((m) => m.cuenta_bancaria_id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ];
      const { data: cuentas } = await this.supabase.service
        .from('cuenta_bancaria')
        .select('id, moneda')
        .in('id', cuentaIds);
      const monedaDe = new Map<string, string>();
      for (const c of (cuentas ?? []) as Array<{
        id: string;
        moneda: string;
      }>) {
        monedaDe.set(c.id, c.moneda);
      }

      const fechas = pendientes.map((m) => m.fecha as string).sort();
      const desde = ventanaDias(fechas[0], MATCH_DAYS).desde;
      const hasta = ventanaDias(fechas[fechas.length - 1], MATCH_DAYS).hasta;
      const { data: gastos, error } = await this.gastosCandidatos({
        moneda: null, // la moneda se filtra por cuenta, fila por fila
        desde,
        hasta,
        limite: MOTIVO_GASTOS_MAX,
      });
      // Truncado = foto incompleta: mejor no decir nada que decir «sin
      // candidato» de un gasto que sí existe.
      if (error || !gastos || gastos.length >= MOTIVO_GASTOS_MAX) return;

      // Índice por monto (centavos) para no comparar N×M.
      const porMonto = new Map<string, Array<Record<string, unknown>>>();
      for (const g of gastos) {
        const k = (Number(g.monto) || 0).toFixed(2);
        const lista = porMonto.get(k) ?? [];
        lista.push(g);
        porMonto.set(k, lista);
      }
      const ctx = await this.cargarCtxCruce();

      for (const m of pendientes) {
        const moneda = monedaDe.get(m.cuenta_bancaria_id as string) ?? null;
        if (!moneda) continue;
        const fecha = m.fecha as string;
        const { desde: lo, hasta: hi } = ventanaDias(fecha, MATCH_DAYS);
        const monto = Math.abs(Number(m.monto)) || 0;
        const claves = new Set([
          monto.toFixed(2),
          (monto - TOLERANCIA_CENTAVOS).toFixed(2),
          (monto + TOLERANCIA_CENTAVOS).toFixed(2),
        ]);
        const candidatos: GastoCandidatoCruce[] = [];
        for (const k of claves) {
          for (const g of porMonto.get(k) ?? []) {
            const f = g.fecha_gasto as string | null;
            if (!f || f < lo || f > hi) continue;
            if ((g.moneda as string | null) !== moneda) continue;
            if (!montoCasa(monto, Number(g.monto))) continue;
            if (candidatos.some((c) => c.id === (g.id as string))) continue;
            candidatos.push(this.aCandidatoCruce(g));
          }
        }
        const eleccion = elegirCandidato(
          {
            monto,
            descripcion: (m.descripcion as string | null) ?? null,
            referencia: (m.referencia as string | null) ?? null,
          },
          candidatos,
          ctx.terminaciones,
        );
        m.candidatos_n = eleccion.candidatos_n;
        m.motivo_pendiente = eleccion.gasto_id
          ? // Cuadra y nadie lo ligó: el auto-cruce no ha corrido sobre él
            // (importación vieja o fallida). «Cruzar pendientes» lo resuelve.
            'SE_PUEDE_CRUZAR'
          : (eleccion.motivo ?? 'SIN_CANDIDATOS');
      }
    } catch (err) {
      this.logger.warn(
        `No se pudo calcular el motivo de los pendientes: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Cargos del banco YA ligados a un gasto, con la MONEDA de su cuenta
   * (14-sep-2026: un gasto admite N cargos de su misma moneda). `excepto`
   * saca de la lista al movimiento que se está ligando/desligando.
   */
  private async cargosDeGasto(
    gastoId: string,
    excepto?: string | null,
  ): Promise<CargoDeGasto[]> {
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, cuenta_bancaria_id, cuenta:cuenta_bancaria(moneda)',
      )
      .eq('gasto_id', gastoId)
      .order('fecha', { ascending: true });
    if (excepto) q = q.neq('id', excepto);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map((m) => ({
      id: m.id as string,
      fecha: (m.fecha as string | null) ?? null,
      monto: Math.abs(Number(m.monto)) || 0,
      moneda:
        unwrapOne(
          m.cuenta as { moneda?: string } | { moneda?: string }[] | null,
        )?.moneda ?? null,
    }));
  }

  /**
   * Estado de conciliación de un gasto a partir de SUS cargos ligados:
   * cuánto suma, cuánto falta y si está CUBIERTO (= `gasto.conciliado`,
   * fuente única `cubreGasto`). Un cargo de OTRA moneda (gasto USD contra
   * cuenta MXN) es 1 ↔ 1 y se da por cubierto: de él se deriva el `tc_gasto`
   * (invariante 7) y su monto no es comparable con el del gasto.
   */
  private estadoConciliacion(
    gasto: { monto: unknown; moneda?: string | null },
    cargos: CargoDeGasto[],
  ): {
    suma: number;
    faltante: number;
    cubierto: boolean;
    cruzado: boolean;
  } {
    const monto = Math.abs(Number(gasto.monto)) || 0;
    const moneda = (gasto.moneda as string | null) ?? null;
    const cruzados = cargos.filter(
      (c) => c.moneda != null && moneda != null && c.moneda !== moneda,
    );
    if (cruzados.length > 0) {
      return { suma: monto, faltante: 0, cubierto: true, cruzado: true };
    }
    const suma = r2(cargos.reduce((acc, c) => acc + c.monto, 0));
    return {
      suma,
      faltante: faltanteDe(monto, suma),
      cubierto: cargos.length > 0 && cubreGasto(monto, suma),
      cruzado: false,
    };
  }

  /**
   * 409 explicado (GASTO_YA_CUBIERTO) con los cargos que ya lo cubren.
   * `montoNuevo` = el cargo que se intentó ligar: sin cargos previos (el
   * PRIMER cargo ya rebasa el ticket) el texto tiene que hablar de ÉL, no
   * decir «ya está cubierto: $0.00 de $277.79».
   */
  private conflictoGastoCubierto(
    gasto: { monto: unknown; moneda?: string | null },
    cargos: CargoDeGasto[],
    motivo: MotivoNoLigar,
    monedaCuenta?: string | null,
    montoNuevo?: number,
  ): ConflictException {
    const montoGasto = Math.abs(Number(gasto.monto)) || 0;
    const sumaLigada = r2(cargos.reduce((acc, c) => acc + c.monto, 0));
    return new ConflictException({
      message:
        motivo === 'MONEDA_DISTINTA'
          ? mensajeMonedaDistinta({
              monedaGasto: (gasto.moneda as string | null) ?? null,
              monedaCuenta: monedaCuenta ?? cargos[0]?.moneda ?? null,
              cargos,
            })
          : mensajeGastoYaCubierto({
              montoGasto,
              sumaLigada,
              cargos,
              montoNuevo,
            }),
      error: 'GASTO_YA_CUBIERTO',
      details: {
        motivo,
        monto_gasto: r2(montoGasto),
        // Moneda del GASTO (aditivo): el panel imprime el sufijo USD en los
        // textos del 409 sin adivinarla.
        moneda: (gasto.moneda as string | null) ?? null,
        suma_ligada: sumaLigada,
        faltante: faltanteDe(montoGasto, sumaLigada),
        monto_nuevo: montoNuevo != null ? r2(Math.abs(montoNuevo)) : null,
        movimientos: cargos.map((c) => ({
          id: c.id,
          fecha: c.fecha,
          monto: c.monto,
        })),
      },
    });
  }

  /**
   * Recalcula `gasto.conciliado` desde SUS cargos ligados (fuente única
   * `cubreGasto`): cubierto ⇒ true, parcial o sin cargos ⇒ false. Se llama
   * SIEMPRE después de mover una liga (al ligar y al desligar): antes se
   * ponía `false` a ciegas y un gasto pagado en dos cargos se "des-conciliaba"
   * al soltar uno solo de ellos.
   *
   * `montoDesligado` (monto del cargo que se acaba de soltar) limpia el
   * `tc_gasto` DERIVADO de ese cargo cuando ya no queda ninguno;
   * `tcDerivado` lo escribe al ligar una compra USD contra un cargo MXN.
   * Un fallo aquí LANZA (fail-loud): un gasto con la bandera equivocada
   * desaparece de la bandeja o se vuelve a cruzar con otro cargo.
   */
  private async recalcularGasto(
    gastoId: string,
    userId: string,
    opts: { tcDerivado?: number | null; montoDesligado?: number } = {},
  ): Promise<{ suma: number; faltante: number; cubierto: boolean }> {
    const { data: gasto, error } = await this.supabase.service
      .from('gasto')
      .select('id, monto, moneda, tc_gasto, conciliado')
      .eq('id', gastoId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!gasto) return { suma: 0, faltante: 0, cubierto: false };
    const cargos = await this.cargosDeGasto(gastoId);
    const est = this.estadoConciliacion(gasto, cargos);
    const limpiarTc =
      opts.montoDesligado != null &&
      cargos.length === 0 &&
      gasto.moneda === 'USD' &&
      gasto.tc_gasto != null &&
      Number(gasto.monto) > 0 &&
      Math.abs(
        Number(gasto.tc_gasto) - opts.montoDesligado / Number(gasto.monto),
      ) < 0.001;
    const patch: Record<string, unknown> = {
      conciliado: est.cubierto,
      updated_by: userId,
    };
    if (limpiarTc) patch.tc_gasto = null;
    if (opts.tcDerivado != null) patch.tc_gasto = opts.tcDerivado;
    const { error: upErr } = await this.supabase.service
      .from('gasto')
      .update(patch)
      .eq('id', gastoId);
    if (upErr) {
      throw new Error(
        `El movimiento quedó guardado pero no se pudo recalcular la conciliación del gasto: ${upErr.message}`,
      );
    }
    return { suma: est.suma, faltante: est.faltante, cubierto: est.cubierto };
  }

  /**
   * Vincula (o desvincula si gastoId es null) un movimiento con un gasto.
   *
   * PAGOS PARCIALES (14-sep-2026, caso real: UNA factura de ASUR cobrada en
   * DOS cargos de tarjeta). Un gasto admite VARIOS cargos siempre que:
   *  - todos sean de la MISMA moneda que el gasto (si el cargo es de otra
   *    moneda sigue siendo 1 ↔ 1: de ese cargo sale el `tc_gasto`), y
   *  - la suma de |monto| no rebase `gasto.monto + TOLERANCIA_CONCILIACION`
   *    (si de verdad son dos pagos de la misma factura, el gasto debe valer
   *    la suma de los dos ⇒ 409 `GASTO_YA_CUBIERTO` explicado).
   * `gasto.conciliado` se recalcula SIEMPRE con la suma (`cubreGasto`): un
   * pago parcial deja el gasto en la bandeja con `monto_vinculado`/`faltante`.
   * Campos ADITIVOS de la respuesta: `gasto_conciliado`, `monto_vinculado`,
   * `faltante` (null al desvincular).
   */
  async link(movId: string, gastoId: string | null, userId: string) {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select('id, gasto_id, monto, cuenta_bancaria_id')
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const prevGasto = (mov as { gasto_id: string | null }).gasto_id;
    const movMonto = Math.abs(Number((mov as { monto: unknown }).monto)) || 0;

    type GastoLink = {
      id: string;
      conciliado: boolean;
      moneda: string | null;
      monto: number;
      tc_gasto: number | null;
    };
    let gastoVinculado: GastoLink | null = null;
    let cuentaMoneda: string | null = null;
    if (gastoId) {
      const { data: gasto, error: gastoErr } = await this.supabase.service
        .from('gasto')
        .select('id, conciliado, moneda, monto, tc_gasto')
        .eq('id', gastoId)
        .maybeSingle();
      if (gastoErr) throw new Error(gastoErr.message);
      if (!gasto) throw new BadRequestException('Gasto no encontrado.');
      gastoVinculado = gasto;
      cuentaMoneda = await this.monedaCuenta(
        (mov as { cuenta_bancaria_id: string }).cuenta_bancaria_id,
      );
      // Solo al ENTRAR una liga nueva: re-ligar el mismo gasto es idempotente.
      if (gastoId !== prevGasto) {
        const monedaGasto = gastoVinculado.moneda ?? null;
        const otros = await this.cargosDeGasto(gastoId, movId);
        const cruzados = otros.filter(
          (c) =>
            c.moneda != null && monedaGasto != null && c.moneda !== monedaGasto,
        );
        // Ya conciliado contra otra moneda (1 ↔ 1): ningún cargo más.
        if (cruzados.length > 0) {
          throw this.conflictoGastoCubierto(
            gastoVinculado,
            otros,
            'MONEDA_DISTINTA',
            cruzados[0].moneda,
            movMonto,
          );
        }
        const mismaMoneda =
          cuentaMoneda == null ||
          monedaGasto == null ||
          cuentaMoneda === monedaGasto;
        const sumaLigada = r2(otros.reduce((acc, c) => acc + c.monto, 0));
        const veredicto = puedeLigar({
          montoGasto: Number(gastoVinculado.monto),
          sumaLigada,
          montoNuevo: movMonto,
          mismaMoneda,
          yaHayLigados: otros.length > 0,
        });
        if (!veredicto.ok) {
          throw this.conflictoGastoCubierto(
            gastoVinculado,
            otros,
            veredicto.motivo ?? 'GASTO_YA_CUBIERTO',
            cuentaMoneda,
            movMonto,
          );
        }
      }
    }

    const { data, error } = await this.supabase.service
      .from('movimiento_bancario')
      .update({
        gasto_id: gastoId,
        conciliado: gastoId !== null,
        // Vincular un gasto real pisa la clasificación "sin vuelo" (son
        // excluyentes); al desvincular, el movimiento vuelve a pendiente.
        clasificacion_id: null,
        updated_by: userId,
      })
      .eq('id', movId)
      .select(MOV_COLS)
      .maybeSingle();
    if (error) {
      const msg = error.message ?? '';
      // Trigger tg_mov_bancario_gasto_suma (migración 20260914000001): cierra
      // el TOCTOU que antes cerraba el índice único uq_mov_bancario_gasto —
      // dos ligas simultáneas al mismo gasto pasan el check previo, pero en
      // la BD solo cabe la que no rebasa el monto.
      if (
        (error.code === '23514' || msg.includes('23514')) &&
        msg.includes('GASTO_YA_CUBIERTO')
      ) {
        const gasto = gastoVinculado ?? { monto: 0, moneda: null };
        const cargos = gastoId
          ? await this.cargosDeGasto(gastoId, movId).catch(
              () => [] as CargoDeGasto[],
            )
          : [];
        throw this.conflictoGastoCubierto(
          gasto,
          cargos,
          msg.includes('MONEDA') ? 'MONEDA_DISTINTA' : 'GASTO_YA_CUBIERTO',
          cuentaMoneda,
          movMonto,
        );
      }
      // Índice único uq_mov_bancario_gasto (mientras la migración
      // 20260914000001 no esté aplicada): el gasto sigue siendo 1 ↔ 1.
      if (error.code === '23505' || msg.includes('23505'))
        throw new ConflictException(
          'Ese gasto ya está vinculado a otro movimiento bancario.',
        );
      if (error.code === '23503')
        throw new BadRequestException('Gasto no encontrado.');
      throw new Error(msg);
    }

    // El gasto ANTERIOR se recalcula con los cargos que le QUEDAN (puede
    // seguir cubierto por otro pago del mismo ticket): ya no se pone
    // conciliado=false a ciegas.
    if (prevGasto && prevGasto !== gastoId) {
      await this.recalcularGasto(prevGasto, userId, {
        montoDesligado: movMonto,
      });
    }

    let estado: { suma: number; faltante: number; cubierto: boolean } | null =
      null;
    if (gastoId) {
      // Compra en DÓLARES conciliada contra un cargo en PESOS: el estado de
      // cuenta REVELA el tipo de cambio real del banco (cargo MXN ÷ gasto
      // USD). Se guarda como tc_gasto para que el balance por avión y los
      // reportes usen los pesos exactos que se pagaron — sin capturas extra.
      let tcDerivado: number | null = null;
      if (
        gastoVinculado?.moneda === 'USD' &&
        gastoVinculado.tc_gasto == null &&
        Number(gastoVinculado.monto) > 0 &&
        movMonto > 0
      ) {
        const tc = movMonto / Number(gastoVinculado.monto);
        if (
          cuentaMoneda === 'MXN' &&
          tc >= TC_IMPLICITO_MIN &&
          tc <= TC_IMPLICITO_MAX
        ) {
          // 6 decimales (17-sep-2026, fuente única tc.util): con 4, un gasto
          // de 722.90 USD × 17.2244 ya no reproducía los 12,451.49 MXN que
          // el banco cobró — el TC derivado tiene que cerrar al centavo.
          tcDerivado = round6(tc);
        }
      }
      estado = await this.recalcularGasto(gastoId, userId, { tcDerivado });
    }
    // Aditivos (14-sep-2026): el panel decide el toast «Gasto cubierto» vs
    // «Pago parcial: faltan $X» con la respuesta, sin recalcular nada.
    return {
      ...data!,
      gasto_conciliado: estado ? estado.cubierto : null,
      monto_vinculado: estado ? estado.suma : null,
      faltante: estado ? estado.faltante : null,
    };
  }

  /**
   * Sugiere (vía Claude en pyservices) el gasto más probable para un
   * movimiento bancario sin conciliar y ambiguo.
   *
   * CONTEXTO RICO (15-sep-2026): antes al modelo solo le llegaban
   * {fecha, monto, descripcion} del movimiento y {id, fecha, monto,
   * proveedor} de cada candidato — estaba CIEGO justo a lo que desempata:
   * la referencia (donde va la terminación de la tarjeta), la moneda de la
   * cuenta, el lugar / la primera línea de las notas del gasto, su tarjeta,
   * su categoría, su matrícula y su faltante. Ahora viaja todo eso y la
   * respuesta admite `evidencias` y `alternativas`.
   *
   * La IA PROPONE y NUNCA liga: esto es solo-lectura.
   * Best-effort: si pyservices no está configurado o falla, devuelve
   * disponible=false con los candidatos para que el operador elija a mano.
   */
  async sugerir(
    movId: string,
    userId?: string,
  ): Promise<SugerenciaConciliacion> {
    const { data: mov, error: movErr } = await this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, descripcion, referencia, conciliado, cuenta_bancaria_id, cuenta:cuenta_bancaria(alias, banco, moneda)',
      )
      .eq('id', movId)
      .maybeSingle();
    if (movErr) throw new Error(movErr.message);
    if (!mov) throw new NotFoundException(`Movimiento ${movId} not found`);

    const m = mov as Record<string, unknown>;
    if (m.conciliado) {
      throw new BadRequestException('El movimiento ya está conciliado.');
    }
    return this.sugerirDeMovimiento(m, userId);
  }

  /**
   * Núcleo de la sugerencia (lo comparten `sugerir` y `sugerir-lote`): arma
   * el contexto, llama a pyservices y filtra la respuesta contra los
   * candidatos REALES (la IA jamás puede inventar un id).
   */
  private async sugerirDeMovimiento(
    m: Record<string, unknown>,
    userId?: string,
  ): Promise<SugerenciaConciliacion> {
    const movId = m.id as string;
    const cuenta = unwrapOne(
      m.cuenta as { alias?: unknown; banco?: unknown; moneda?: unknown } | null,
    );
    const moneda = (cuenta?.moneda as string | null) ?? null;
    const candidatos = await this.candidatosCercanos(
      Number(m.monto),
      m.fecha as string,
      moneda,
    );
    const ctx = await this.cargarCtxCruce();
    const terminacion = terminacionDeMovimiento(
      (m.referencia as string | null) ?? null,
      (m.descripcion as string | null) ?? null,
      ctx.terminaciones,
    );
    const vacia = (razon: string, disponible = true) => ({
      disponible,
      gasto_id_sugerido: null,
      confianza: 0,
      razon,
      evidencias: [] as string[],
      alternativas: [] as SugerenciaConciliacion['alternativas'],
      terminacion_detectada: terminacion,
      motivo_sin_match: razon,
      candidatos,
    });
    if (candidatos.length === 0) {
      return vacia(
        'No hay gastos candidatos cercanos (±3 días y ±5% de monto) sin conciliar.',
      );
    }

    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      return vacia(
        'Asistente de conciliación no configurado (pyservices).',
        false,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${baseUrl}/conciliacion/sugerir`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify({
          movimiento: {
            fecha: m.fecha,
            monto: Number(m.monto),
            descripcion: (m.descripcion as string | null) ?? null,
            referencia: (m.referencia as string | null) ?? null,
            tipo: (m.tipo as string | null) ?? null,
            cuenta_alias:
              (cuenta?.alias as string | null) ??
              (cuenta?.banco as string | null) ??
              null,
            cuenta_moneda: moneda,
            terminacion_tarjeta_detectada: terminacion,
          },
          candidatos,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `pyservices /conciliacion/sugerir respondió ${res.status}`,
        );
        return vacia(`pyservices respondió ${res.status}.`, false);
      }
      const data = (await res.json()) as {
        gasto_id_sugerido: string | null;
        confianza: number;
        razon: string;
        evidencias?: unknown;
        alternativas?: unknown;
        motivo_sin_match?: unknown;
        uso_ia?: UsoIaPayload | null;
      };
      this.iaUso.registrar('CONCILIACION_SUGERIR', data.uso_ia, {
        usuarioId: userId ?? null,
        contexto: { movimiento_id: movId },
      });
      // Solo aceptamos ids que estén realmente entre los candidatos.
      const validos = new Set(candidatos.map((c) => c.id));
      const sugerido = validos.has(data.gasto_id_sugerido as string)
        ? (data.gasto_id_sugerido as string)
        : null;
      const evidencias = Array.isArray(data.evidencias)
        ? data.evidencias
            .filter((e): e is string => typeof e === 'string')
            .slice(0, 8)
        : [];
      const alternativas = Array.isArray(data.alternativas)
        ? data.alternativas
            .map((a) => a as Record<string, unknown>)
            .filter(
              (a) =>
                typeof a?.gasto_id === 'string' &&
                validos.has(a.gasto_id) &&
                a.gasto_id !== sugerido,
            )
            .map((a) => ({
              gasto_id: a.gasto_id as string,
              confianza: Number(a.confianza) || 0,
              razon: typeof a.razon === 'string' ? a.razon : '',
            }))
            .slice(0, 5)
        : [];
      return {
        disponible: true,
        gasto_id_sugerido: sugerido,
        confianza: sugerido ? data.confianza : 0,
        razon: data.razon ?? '',
        evidencias,
        alternativas,
        terminacion_detectada: terminacion,
        motivo_sin_match: sugerido
          ? null
          : typeof data.motivo_sin_match === 'string'
            ? data.motivo_sin_match.slice(0, 300)
            : null,
        candidatos,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`sugerir conciliación falló: ${msg}`);
      return vacia(
        `No se pudo contactar al asistente de conciliación: ${msg}`,
        false,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sugerencias EN LOTE para los pendientes de una ventana (15-sep-2026).
   * Corre la MISMA sugerencia individual sobre los movimientos que todavía
   * tienen candidatos y devuelve PROPUESTAS: no liga nada — el operador las
   * confirma en el panel. Cada llamada consume créditos de IA, por eso el
   * tope es bajo y explícito.
   */
  async sugerirLote(dto: SugerirLoteDto, userId: string) {
    const hasta = dto.hasta ?? hoyCancun();
    const desde =
      dto.desde ?? hoyCancun(new Date(Date.now() - 90 * 24 * 3600 * 1000));
    if (desde > hasta) {
      throw new BadRequestException('desde no puede ser posterior a hasta');
    }
    const limite = Math.min(dto.limite ?? 15, 40);
    let q = this.supabase.service
      .from('movimiento_bancario')
      .select(
        'id, fecha, monto, tipo, descripcion, referencia, conciliado, cuenta_bancaria_id, cuenta:cuenta_bancaria(alias, banco, moneda)',
      )
      .eq('conciliado', false)
      .eq('tipo', TipoMovimientoBancario.CARGO)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .order('fecha', { ascending: true })
      .limit(limite);
    if (dto.cuenta_bancaria_id)
      q = q.eq('cuenta_bancaria_id', dto.cuenta_bancaria_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const propuestas: Array<{
      movimiento_id: string;
      fecha: string;
      monto: number;
      descripcion: string | null;
      referencia: string | null;
      gasto_id_sugerido: string | null;
      confianza: number;
      razon: string;
      evidencias: string[];
      alternativas: SugerenciaConciliacion['alternativas'];
      motivo_sin_match: string | null;
      /** Ficha del gasto propuesto (null si la IA no propuso ninguno). */
      gasto: SugerenciaConciliacion['candidatos'][number] | null;
      candidatos: SugerenciaConciliacion['candidatos'];
      candidatos_n: number;
    }> = [];
    let errores = 0;
    let sinCandidatos = 0;
    // ¿El asistente contestó ALGUNA vez? Si pyservices no está configurado o
    // no responde, todas vuelven `disponible:false` y decir «la IA no
    // encontró propuestas» sería mentir: nunca se le preguntó.
    let consultados = 0;
    let disponibles = 0;
    let notaNoDisponible: string | null = null;
    for (const m of (data ?? []) as Array<Record<string, unknown>>) {
      try {
        const s = await this.sugerirDeMovimiento(m, userId);
        if (s.candidatos.length === 0) {
          sinCandidatos += 1;
          continue;
        }
        consultados += 1;
        if (s.disponible) disponibles += 1;
        else notaNoDisponible ??= s.razon || null;
        propuestas.push({
          movimiento_id: m.id as string,
          fecha: m.fecha as string,
          monto: Number(m.monto),
          descripcion: (m.descripcion as string | null) ?? null,
          referencia: (m.referencia as string | null) ?? null,
          gasto_id_sugerido: s.gasto_id_sugerido,
          confianza: s.confianza,
          razon: s.razon,
          evidencias: s.evidencias ?? [],
          alternativas: s.alternativas ?? [],
          motivo_sin_match: s.motivo_sin_match ?? null,
          // Ficha del gasto propuesto y lista de candidatos: sin ellas el
          // panel solo podría pintar un uuid y el operador no tendría con
          // qué confirmar (la IA propone, la persona decide).
          gasto: s.candidatos.find((c) => c.id === s.gasto_id_sugerido) ?? null,
          candidatos: s.candidatos,
          candidatos_n: s.candidatos.length,
        });
      } catch (err) {
        errores += 1;
        this.logger.warn(
          `sugerir-lote: movimiento ${m.id as string}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const conPropuesta = propuestas.filter((p) => p.gasto_id_sugerido).length;
    return {
      revisados: (data ?? []).length,
      con_propuesta: conPropuesta,
      sin_candidatos: sinCandidatos,
      // Alias del contrato del panel (mismo dato, su nombre): cuántos
      // pendientes se quedaron sin una propuesta que confirmar.
      sin_propuesta: (data ?? []).length - conPropuesta,
      errores,
      desde,
      hasta,
      limite,
      // `false` SOLO si se preguntó y NADIE contestó: el panel lo dice tal
      // cual («el asistente no está configurado») en vez de «no encontró
      // nada».
      disponible: consultados === 0 ? true : disponibles > 0,
      nota: consultados > 0 && disponibles === 0 ? notaNoDisponible : null,
      propuestas,
    };
  }

  /** Gastos sin conciliar dentro de ±MATCH_DAYS días y ±MATCH_MONTO_PCT de monto. */
  private async candidatosCercanos(
    monto: number,
    fecha: string,
    moneda: string | null,
  ): Promise<SugerenciaConciliacion['candidatos']> {
    const { desde: lo, hasta: hi } = ventanaDias(fecha, MATCH_DAYS);

    const delta = Math.abs(monto) * MATCH_MONTO_PCT;
    const montoLo = monto - delta;
    const montoHi = monto + delta;

    const traer = async (opts: {
      moneda: string | null;
      montoMin?: number;
      montoMax?: number;
      mayorQue?: number;
      limite: number;
      /** Un fallo aquí no debe tumbar la sugerencia completa. */
      tolerante?: boolean;
    }) => {
      const { data, error } = await this.gastosCandidatosRicos({
        desde: lo,
        hasta: hi,
        ...opts,
      });
      if (error) {
        if (opts.tolerante) return [];
        throw new Error(error.message);
      }
      return data ?? [];
    };

    const propiosRaw = await traer({
      moneda,
      montoMin: montoLo,
      montoMax: montoHi,
      limite: 15,
    });

    // PAGOS PARCIALES (14-sep-2026): una factura pagada en dos cargos tiene
    // `monto` MAYOR que este cargo — no cae en la banda de monto. Se buscan
    // aparte los gastos más caros de la ventana y se comparan contra su
    // FALTANTE (monto − lo ya vinculado), que es lo que este cargo cubriría.
    let masCaros: Array<Record<string, unknown>> = [];
    if (montoHi > 0) {
      masCaros = await traer({
        moneda,
        mayorQue: montoHi,
        limite: 40,
        tolerante: true,
      });
    }

    const vinculado = await this.sumasLigadasDe([
      ...propiosRaw.map((g) => g.id as string),
      ...masCaros.map((g) => g.id as string),
    ]);

    const aCandidato = (
      g: Record<string, unknown>,
      tcImplicito: number | null,
    ) => {
      const prov = unwrapOne(
        g.proveedor as { nombre?: unknown } | { nombre?: unknown }[] | null,
      );
      const vuelo = unwrapOne(g.vuelo as { folio?: unknown } | null);
      const avion = unwrapOne(g.aeronave as { matricula?: unknown } | null);
      const captura = unwrapOne(g.captura as { nombre?: unknown } | null);
      const ligado = vinculado.get(g.id as string) ?? 0;
      return {
        id: g.id as string,
        fecha: (g.fecha_gasto as string | null) ?? null,
        monto: Number(g.monto),
        moneda: (g.moneda as string | null) ?? undefined,
        tc_implicito: tcImplicito,
        proveedor: typeof prov?.nombre === 'string' ? prov.nombre : null,
        // Aditivos (14-sep-2026): con pagos parciales el candidato se juzga
        // por lo que FALTA, no por su monto total.
        monto_vinculado: ligado,
        faltante: faltanteDe(Number(g.monto), ligado),
        // Aditivos (15-sep-2026): el contexto que la IA no tenía y que el
        // panel también pinta en el selector de «Vincular gasto».
        medio_pago: (g.medio_pago as string | null) ?? null,
        tarjeta_terminacion: (g.tarjeta_terminacion as string | null) ?? null,
        categoria: (g.categoria as string | null) ?? null,
        lugar: (g.lugar as string | null) ?? null,
        nota: primeraLinea(g.notas as string | null) || null,
        matricula:
          typeof avion?.matricula === 'string' ? avion.matricula : null,
        vuelo_folio: vuelo?.folio == null ? null : Number(vuelo.folio),
        capturado_por:
          typeof captura?.nombre === 'string' ? captura.nombre : null,
      };
    };
    const propios = propiosRaw.map((g) => aCandidato(g, null));
    const parciales = masCaros
      .filter((g) => {
        const ligado = vinculado.get(g.id as string) ?? 0;
        if (!(ligado > 0)) return false;
        const falta = faltanteDe(Number(g.monto), ligado);
        return falta >= montoLo && falta <= montoHi;
      })
      .map((g) => aCandidato(g, null));

    // Cuenta en PESOS: una compra EN DÓLARES cuyo cargo llegó en MXN no cae
    // en la banda del monto — se ofrece aparte si su TC implícito (cargo ÷
    // gasto USD) es plausible, con el TC visible para que el operador decida.
    if (moneda !== 'MXN' || !(monto > 0)) return [...propios, ...parciales];
    const usd = await traer({ moneda: 'USD', limite: 15, tolerante: true });
    const cruzados = usd
      .map((g) => {
        const m = Number(g.monto);
        const tc = m > 0 ? monto / m : 0;
        return tc >= TC_IMPLICITO_MIN && tc <= TC_IMPLICITO_MAX
          ? aCandidato(g, round6(tc))
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
    return [...propios, ...parciales, ...cruzados];
  }

  /**
   * Candidatos con TODO el contexto que se le manda a la IA y al panel
   * (matrícula, vuelo, captura). Mismo universo que `gastosCandidatos`: solo
   * cambia el select.
   */
  private async gastosCandidatosRicos(opts: {
    moneda: string | null;
    desde: string;
    hasta: string;
    montoMin?: number;
    montoMax?: number;
    mayorQue?: number;
    limite: number;
  }): Promise<{
    data: Array<Record<string, unknown>> | null;
    error: { message: string } | null;
  }> {
    let q = this.supabase.service
      .from('gasto')
      .select(
        `${GASTO_CRUCE_COLS}, aeronave:aeronave!aeronave_id(matricula), vuelo:vuelo!vuelo_id(folio), captura:usuario!usuario_captura_id(nombre)`,
      )
      .eq('conciliado', false)
      .in('medio_pago', MEDIOS_BANCARIOS)
      .gte('fecha_gasto', opts.desde)
      .lte('fecha_gasto', opts.hasta);
    if (opts.moneda) q = q.eq('moneda', opts.moneda);
    if (opts.montoMin != null) q = q.gte('monto', opts.montoMin);
    if (opts.montoMax != null) q = q.lte('monto', opts.montoMax);
    if (opts.mayorQue != null) q = q.gt('monto', opts.mayorQue);
    const { data, error } = await q.limit(opts.limite);
    return {
      data: (data ?? null) as Array<Record<string, unknown>> | null,
      error: error ? { message: error.message } : null,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import {
  VisionService,
  type GastoTicketVisionInput,
} from '../vision/vision.service';
import {
  CONFIG_FOLIOS_RELEER_ACTIVO,
  CONFIG_FOLIOS_RELEER_CAPTURADOS_HASTA,
  CONFIG_FOLIOS_RELEER_DESDE,
  CONFIG_FOLIOS_RELEER_LOTE,
  ConfiguracionService,
} from '../configuracion/configuracion.service';
import { SEGUNDOS_URL_PUNTUAL } from '../../common/url-firmada.util';
import { folioReleidoGastoDisponible } from '../../common/folio-releido-gasto-disponible.util';
import { aplicarCas } from '../../common/version-cas.util';
import { cortarRelecturaPorPyservices } from '../facturacion/recibida-folio.util';
import { folioTicketDeLectura } from './folio-ticket.util';
import {
  CATEGORIA_IA_RELEER_FOLIO,
  FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT,
  FOLIOS_RELEER_DESDE_DEFAULT,
  FOLIOS_RELEER_LOTE_DEFAULT,
  POSTERGADOS_MAX,
  archivosDelComprobante,
  corteCapturadosHasta,
  destinoTrasFallo,
  esArchivoAusente,
  evaluarLecturaFolio,
  falloSinCosto,
  lecturaConFolio,
  lineaFolioDuplicado,
  loteRelectura,
  mismoComprobante,
  notasConLinea,
  ordenarCandidatos,
  registrarFallo,
  tipoDocumento,
  type EstadoPostergado,
  type FalloGasto,
} from './folio-relectura.util';

/**
 * Resultado de UNA corrida del cron `gastos-releer-folio` (log + specs).
 */
export interface ResumenRelecturaFolioGasto {
  /** `false` = `folios_releer_activo` apagada: no hizo nada. */
  activo: boolean;
  /** `false` = la migración 20261006000001 no está aplicada: no hizo nada. */
  disponible: boolean;
  /** Gastos tomados de la cola en esta corrida (≤ lote). */
  tomados: number;
  /** Folio escrito en `folio_ticket` (y en la lectura IA). */
  con_folio: number;
  /** Folio leído que YA es de otro gasto: sin folio, posible duplicado. */
  duplicados: number;
  /** Lectura legible SIN folio: sellados. */
  sin_folio: number;
  /**
   * Comprobante ilegible / archivo ausente o vacío / IA que no lo procesa /
   * gasto que falló `FALLOS_CON_IA_PARA_SELLAR` veces con la IA viva:
   * sellados.
   */
  ilegibles: number;
  /**
   * El gasto cambió mientras se leía (folio a mano, factura, sello, OTRA
   * foto u otras hojas): no se escribe nada.
   */
  omitidos: number;
  /** NO sellados (pyservices, IA, Storage o BD): se reintentan (≥ 1 h). */
  fallos: number;
}

/** Lo que el cron necesita de cada candidato. */
interface GastoCandidato {
  id: string;
  fecha_gasto: string;
  foto_url: string | null;
  valor_ia_extraido: unknown;
}

/** Fila releída JUSTO antes de escribir (CAS). */
interface GastoVigente {
  id: string;
  foto_url: string | null;
  folio_ticket: string | null;
  factura_recibida_id: string | null;
  folio_releido_at: string | null;
  notas: string | null;
  valor_ia_extraido: unknown;
  ia_folio: string | null;
  updated_at: string;
}

type EntradaVision =
  | { ok: true; input: GastoTicketVisionInput }
  | { ok: false; ausente: boolean; motivo: string };

type Escritura =
  | 'CON_FOLIO'
  | 'DUPLICADO'
  | 'SIN_FOLIO'
  | 'ILEGIBLE'
  | 'OMITIDO'
  | 'FALLO';

/** Qué escribir: el folio leído, o solo el sello (con o sin lectura). */
type Decision =
  | { tipo: 'FOLIO'; folio: string; lectura: Record<string, unknown> }
  | { tipo: 'SIN_FOLIO' }
  | { tipo: 'ILEGIBLE' };

const BUCKET_FOTOS = 'gasto-fotos';

const COLS_CANDIDATO = 'id, fecha_gasto, foto_url, valor_ia_extraido';
const COLS_VIGENTE =
  'id, foto_url, folio_ticket, factura_recibida_id, folio_releido_at, notas, valor_ia_extraido, ia_folio:valor_ia_extraido->>folio, updated_at';

/**
 * RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (6-oct-2026, API 0.0.58,
 * invariante 46 del CLAUDE.md). Pedido aprobado por el cliente: una pasada
 * de IA sobre los gastos con foto y SIN ningún folio (ni `folio_ticket`, ni
 * factura recibida, ni folio en la lectura IA guardada) para que el Excel de
 * conciliación muestre el número de factura (invariante 44).
 *
 * Servicio APARTE de `ExpensesService` a propósito (no lo engorda y no
 * comparte estado con la captura). Reglas:
 * - Solo con la migración 20261006000001 (sonda `gasto.folio_releido_at`) y
 *   la clave `folios_releer_activo` encendida (default sí). Sin visión
 *   configurada no lee nada.
 * - Candidatos: foto, sin `folio_ticket`, sin factura, sin folio en la
 *   lectura IA, `folio_releido_at is null`, `fecha_gasto >= desde` y
 *   capturados hasta `folios_releer_capturados_hasta` (lo nuevo ya se leyó
 *   con el prompt afinado y es lo que la tripulación sigue editando).
 *   `fecha_gasto` desc, de `folios_releer_lote` en `folios_releer_lote`.
 * - (a) folio leído ⇒ `folio_ticket`, la llave `folio` de la lectura y el
 *   sello; (b) ese folio ya es de OTRO gasto (23505 del índice único) ⇒ sin
 *   folio, `duplicado_sospechado` y la línea «⚠ IA: folio X ya existe en
 *   otro gasto — revisar» en notas; (c) legible sin folio o ilegible ⇒ solo
 *   el sello; (d) pyservices caído / IA sin saldo / red ⇒ NO se sella y la
 *   corrida se corta (sin saldo de inmediato; lo transitorio con DOS fallos
 *   seguidos, como el cron de recibidas). Un gasto que falla se reintenta
 *   a lo más cada hora; con `FALLOS_CON_IA_PARA_SELLAR` fallos «con la IA
 *   viva» se sella como ilegible y con `INTENTOS_MAX_POR_GASTO` sin esa
 *   prueba sale de la cola hasta reiniciar (`registrarFallo`): ningún
 *   gasto se lee sin tope.
 * - Toda escritura relee la fila: si el comprobante ya no es el que se leyó
 *   (otra foto u otras hojas, `mismoComprobante`) o alguien puso folio,
 *   factura o sello, no escribe nada. El UPDATE lleva CAS (`folio_ticket`,
 *   `folio_releido_at` y `factura_recibida_id` en null + `updated_at` de la
 *   fila releída): lo que cambie entre la relectura y el UPDATE tampoco se
 *   pisa. Otros cambios (monto, notas) no invalidan el folio leído.
 * - Actor: `updated_by = null` en (a) y (b) ⇒ la bitácora (`tg_gasto_
 *   bitacora`, actor = `new.updated_by`) lo pinta «Sistema»; sin él el
 *   cambio se atribuiría a quien editó el gasto por última vez (el piloto).
 *   (c) no toca ninguna columna de la bitácora y no cambia `updated_by`.
 * Nunca lanza: un fallo se registra con `warn`.
 */
@Injectable()
export class FolioRelecturaService {
  private readonly logger = new Logger(FolioRelecturaService.name);

  /** Candado en proceso: una corrida a la vez (Railway = 1 réplica). */
  private enCurso = false;

  /**
   * Gastos que fallaron sin sellarse, con sus contadores
   * (`EstadoPostergado`; orden de inserción = del que falló hace más al más
   * reciente): van AL FINAL de la cola, a lo más una vez por hora
   * (`ordenarCandidatos`). En memoria y acotado: un reinicio los olvida y
   * vuelven a su lugar con los contadores en cero.
   */
  private readonly postergados = new Map<string, EstadoPostergado>();

  /** Epoch ms de la última lectura que la IA CONTESTÓ (cualquier gasto). */
  private ultimaRespuestaIa: number | null = null;

  private avisadoSinVision = false;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly vision: VisionService,
    private readonly configuracion: ConfiguracionService,
  ) {}

  @Cron('*/5 * * * *', { name: 'gastos-releer-folio' })
  async releerFoliosGastos(): Promise<ResumenRelecturaFolioGasto | null> {
    if (this.enCurso) return null;
    this.enCurso = true;
    try {
      return await this.releerLote();
    } catch (err) {
      this.logger.warn(
        `releerFoliosGastos falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.enCurso = false;
    }
  }

  /** Ids postergados en su orden (specs). */
  postergadosActuales(): string[] {
    return [...this.postergados.keys()];
  }

  /** Contadores de un gasto postergado (specs). */
  estadoPostergado(id: string): EstadoPostergado | undefined {
    const e = this.postergados.get(id);
    return e ? { ...e } : undefined;
  }

  private async releerLote(): Promise<ResumenRelecturaFolioGasto> {
    const resumen: ResumenRelecturaFolioGasto = {
      activo: false,
      disponible: false,
      tomados: 0,
      con_folio: 0,
      duplicados: 0,
      sin_folio: 0,
      ilegibles: 0,
      omitidos: 0,
      fallos: 0,
    };
    if (
      !(await this.configuracion.isActiva(CONFIG_FOLIOS_RELEER_ACTIVO, true))
    ) {
      return resumen;
    }
    resumen.activo = true;
    const sb = this.supabase.service;
    if (!(await folioReleidoGastoDisponible(sb))) return resumen;
    resumen.disponible = true;
    if (!this.vision.enabled) {
      if (!this.avisadoSinVision) {
        this.avisadoSinVision = true;
        this.logger.warn(
          'Relectura de folio de gastos sin visión IA configurada: no se lee nada',
        );
      }
      return resumen;
    }

    const [loteCfg, desde, hasta] = await Promise.all([
      this.configuracion.numero(
        CONFIG_FOLIOS_RELEER_LOTE,
        FOLIOS_RELEER_LOTE_DEFAULT,
      ),
      this.configuracion.fecha(
        CONFIG_FOLIOS_RELEER_DESDE,
        FOLIOS_RELEER_DESDE_DEFAULT,
      ),
      this.configuracion.fecha(
        CONFIG_FOLIOS_RELEER_CAPTURADOS_HASTA,
        FOLIOS_RELEER_CAPTURADOS_HASTA_DEFAULT,
      ),
    ]);
    const lote = loteRelectura(loteCfg);
    const { data, error } = await sb
      .from('gasto')
      .select(COLS_CANDIDATO)
      .not('foto_url', 'is', null)
      .is('folio_ticket', null)
      .is('factura_recibida_id', null)
      .is('folio_releido_at', null)
      .is('valor_ia_extraido->>folio', null)
      .gte('fecha_gasto', desde)
      .lt('created_at', corteCapturadosHasta(hasta))
      .order('fecha_gasto', { ascending: false })
      .order('id', { ascending: false })
      .limit(lote + this.postergados.size);
    if (error) throw new Error(error.message);
    const inicioCorrida = Date.now();
    const filas = ordenarCandidatos(
      (data ?? []) as GastoCandidato[],
      this.postergados,
      lote,
      inicioCorrida,
    );

    // Fallos TRANSITORIOS de lectura seguidos (vuelve a 0 cuando la IA
    // contesta, con o sin folio, aunque sea algo inservible). Storage no
    // cuenta: solo salta esa fila.
    let fallosSeguidos = 0;
    for (const fila of filas) {
      resumen.tomados += 1;
      // Lo que se lee AHORA es lo que se compara antes de escribir.
      const archivos = archivosDelComprobante(
        fila.foto_url,
        fila.valor_ia_extraido,
      );
      const entrada = await this.entradaVision(archivos);
      let decision: Decision;
      if (!entrada.ok) {
        if (!entrada.ausente) {
          resumen.fallos += 1;
          this.anotarFallo(fila.id, 'STORAGE', false, inicioCorrida);
          this.logger.warn(
            `Relectura de folio: gasto ${fila.id} sin leer por Storage (se reintenta en 1 h): ${entrada.motivo}`,
          );
          continue;
        }
        // El archivo ya no existe o está vacío: no hay nada que leer.
        decision = { tipo: 'ILEGIBLE' };
      } else {
        const lectura = await this.vision.readGastoTicket(entrada.input, {
          categoria: CATEGORIA_IA_RELEER_FOLIO,
          usuarioId: null,
          contexto: { gasto_id: fila.id, origen: 'releer_folio' },
        });
        const ev = evaluarLecturaFolio(lectura);
        if (ev.tipo === 'FALLO') {
          if (ev.fallo === 'IA_NO_DISPONIBLE') {
            // Ninguna otra lectura funcionará (sin saldo, llave, modelo).
            resumen.fallos += 1;
            this.logger.warn(
              `Relectura de folio de gastos pausada (IA no disponible): ${ev.motivo}`,
            );
            break;
          }
          if (ev.fallo === 'RESPUESTA_IA') {
            // La IA contestó (algo inservible): pyservices y la IA viven.
            fallosSeguidos = 0;
            this.ultimaRespuestaIa = Date.now();
          } else {
            fallosSeguidos += 1;
          }
          const fallo: FalloGasto = ev.fallo;
          const destino = this.anotarFallo(
            fila.id,
            fallo,
            fallo === 'TRANSITORIO' && falloSinCosto(ev.motivo),
            inicioCorrida,
          );
          if (destino === 'SELLAR') {
            // Mismo comprobante, mismo fallo, con la IA contestando a
            // otros: el problema es ESTE archivo. Se sella como ilegible.
            const e = this.postergados.get(fila.id);
            this.logger.warn(
              `Relectura de folio: gasto ${fila.id} sellado como ilegible tras ${e?.conIa ?? 0} fallos con la IA viva: ${ev.motivo}`,
            );
            decision = { tipo: 'ILEGIBLE' };
          } else {
            resumen.fallos += 1;
            this.avisarFallo(fila.id, destino, ev.motivo);
            if (cortarRelecturaPorPyservices(fallosSeguidos)) {
              this.logger.warn(
                `Relectura de folio de gastos pausada (pyservices/IA): ${ev.motivo}`,
              );
              break;
            }
            continue;
          }
        } else {
          fallosSeguidos = 0;
          this.ultimaRespuestaIa = Date.now();
          decision =
            ev.tipo === 'FOLIO'
              ? {
                  tipo: 'FOLIO',
                  folio: ev.folio,
                  lectura: lectura as unknown as Record<string, unknown>,
                }
              : { tipo: ev.tipo };
        }
      }

      const r = await this.escribir(fila.id, archivos, decision);
      if (r === 'FALLO') {
        resumen.fallos += 1;
        const destino = this.anotarFallo(
          fila.id,
          'ESCRITURA',
          false,
          inicioCorrida,
        );
        this.avisarFallo(fila.id, destino, 'no se pudo guardar');
        continue;
      }
      this.postergados.delete(fila.id);
      if (r === 'CON_FOLIO') resumen.con_folio += 1;
      else if (r === 'DUPLICADO') resumen.duplicados += 1;
      else if (r === 'SIN_FOLIO') resumen.sin_folio += 1;
      else if (r === 'ILEGIBLE') resumen.ilegibles += 1;
      else resumen.omitidos += 1;
    }
    if (resumen.tomados > 0) {
      this.logger.log(
        `Relectura de folio de gastos: ${JSON.stringify(resumen)}`,
      );
    }
    return resumen;
  }

  /**
   * Registra UN fallo del gasto (`registrarFallo`), lo manda al final de la
   * cola (el más viejo se olvida si se pasa del tope) y dice qué sigue
   * (`destinoTrasFallo`). `RETIRAR` lo deja en el mapa marcado: no se
   * reintenta hasta reiniciar el API.
   */
  private anotarFallo(
    id: string,
    fallo: FalloGasto,
    sinCosto: boolean,
    inicioCorrida: number,
  ): 'SELLAR' | 'RETIRAR' | 'POSTERGAR' {
    const estado = registrarFallo(this.postergados.get(id), {
      fallo,
      sinCosto,
      ahora: Date.now(),
      inicioCorrida,
      ultimaRespuestaIa: this.ultimaRespuestaIa,
    });
    const destino = destinoTrasFallo(estado, fallo);
    if (destino === 'RETIRAR') estado.retirado = true;
    this.postergados.delete(id);
    this.postergados.set(id, estado);
    while (this.postergados.size > POSTERGADOS_MAX) {
      const [primero] = this.postergados.keys();
      this.postergados.delete(primero);
    }
    return destino;
  }

  private avisarFallo(
    id: string,
    destino: 'SELLAR' | 'RETIRAR' | 'POSTERGAR',
    motivo: string,
  ): void {
    const e = this.postergados.get(id);
    this.logger.warn(
      destino === 'RETIRAR'
        ? `Relectura de folio: gasto ${id} fuera de la cola hasta reiniciar el API tras ${e?.intentos ?? 0} intentos fallidos (sin sellar): ${motivo}`
        : `Relectura de folio: gasto ${id} sin leer (se reintenta en 1 h): ${motivo}`,
    );
  }

  /**
   * Lo que se le manda a la IA, como `reanalizarConIA`: PDF/Excel en bytes,
   * imagen por URL firmada de 1 h (`SEGUNDOS_URL_PUNTUAL`: se le entrega a
   * un tercero) y, si hay `fotos_adicionales`, TODAS las hojas juntas
   * (`archivos` = `archivosDelComprobante`). Archivo ausente o VACÍO en
   * Storage ⇒ `ausente` (se sella: con 0 bytes `readGastoTicket` devolvería
   * null, que se confunde con «visión deshabilitada» y atoraría la cola);
   * cualquier otro error de Storage ⇒ transitorio.
   */
  private async entradaVision(
    archivos: readonly string[],
  ): Promise<EntradaVision> {
    const [path] = archivos;
    if (!path) return { ok: false, ausente: true, motivo: 'sin foto' };
    const bucket = this.supabase.service.storage.from(BUCKET_FOTOS);
    const doc = tipoDocumento(path);
    if (doc) {
      const { data, error } = await bucket.download(path);
      if (error || !data) {
        const motivo = error?.message ?? 'sin respuesta de Storage';
        return { ok: false, ausente: esArchivoAusente(motivo), motivo };
      }
      const b64 = Buffer.from(await data.arrayBuffer()).toString('base64');
      if (b64.length === 0) {
        return { ok: false, ausente: true, motivo: 'archivo vacío' };
      }
      return {
        ok: true,
        input:
          doc === 'PDF'
            ? { pdfBase64: b64 }
            : {
                excelBase64: b64,
                excelFilename: path.split('/').pop() ?? 'comprobante.xlsx',
              },
      };
    }
    const paths = [...archivos];
    const { data, error } = await bucket.createSignedUrls(
      paths,
      SEGUNDOS_URL_PUNTUAL,
    );
    if (error || !data) {
      return {
        ok: false,
        ausente: false,
        motivo: error?.message ?? 'sin respuesta de Storage',
      };
    }
    const urls = new Map<string, string>();
    let errorPrincipal: string | null = null;
    for (const it of data) {
      if (it.path && it.signedUrl) urls.set(it.path, it.signedUrl);
      else if (it.path === path) errorPrincipal = it.error ?? null;
    }
    const principal = urls.get(path);
    if (!principal) {
      const motivo = errorPrincipal ?? 'no se pudo firmar la foto';
      return { ok: false, ausente: esArchivoAusente(motivo), motivo };
    }
    if (paths.length > 1) {
      return {
        ok: true,
        input: {
          images: paths
            .filter((p) => urls.has(p))
            .map((p) => ({ imageUrl: urls.get(p)! })),
        },
      };
    }
    return { ok: true, input: { imageUrl: principal } };
  }

  /**
   * Escribe el resultado con la fila RELEÍDA y CAS. Si la fila ya no es
   * candidata (folio a mano, factura ligada, sellada por otro camino,
   * lectura IA con folio, borrada) o su comprobante ya no es el que se leyó
   * (`archivos` ≠ `archivosDelComprobante` de la fila releída: otra foto u
   * otras hojas mientras la IA leía) ⇒ OMITIDO sin escribir: el folio sería
   * de la foto VIEJA y la nueva se lee en otra corrida. Un 23505 al
   * escribir el folio = el índice único `uq_gasto_folio_ticket_norm`: ese
   * folio ya es de otro gasto ⇒ se reintenta como DUPLICADO. 0 filas por el
   * CAS de `updated_at` ⇒ se relee y se decide otra vez (a lo más 3).
   */
  private async escribir(
    gastoId: string,
    archivos: readonly string[],
    decision: Decision,
  ): Promise<Escritura> {
    const sb = this.supabase.service;
    let modo: 'FOLIO' | 'DUPLICADO' | 'SELLO' =
      decision.tipo === 'FOLIO' ? 'FOLIO' : 'SELLO';
    for (let intento = 0; intento < 3; intento += 1) {
      const { data, error: rErr } = await sb
        .from('gasto')
        .select(COLS_VIGENTE)
        .eq('id', gastoId)
        .maybeSingle();
      if (rErr) {
        this.logger.warn(
          `Relectura de folio: no se pudo releer el gasto ${gastoId}: ${rErr.message}`,
        );
        return 'FALLO';
      }
      const actual = data as GastoVigente | null;
      if (
        !actual ||
        actual.folio_ticket ||
        actual.factura_recibida_id ||
        actual.folio_releido_at ||
        folioTicketDeLectura(actual.ia_folio) ||
        !mismoComprobante(
          archivos,
          archivosDelComprobante(actual.foto_url, actual.valor_ia_extraido),
        )
      ) {
        return 'OMITIDO';
      }
      const ahora = new Date().toISOString();
      let patch: Record<string, unknown>;
      if (modo === 'FOLIO' && decision.tipo === 'FOLIO') {
        patch = {
          folio_ticket: decision.folio,
          valor_ia_extraido: lecturaConFolio(
            actual.valor_ia_extraido,
            decision.lectura,
            decision.folio,
          ),
          folio_releido_at: ahora,
          updated_by: null,
        };
      } else if (modo === 'DUPLICADO' && decision.tipo === 'FOLIO') {
        patch = {
          duplicado_sospechado: true,
          notas: notasConLinea(
            actual.notas,
            lineaFolioDuplicado(decision.folio),
          ),
          folio_releido_at: ahora,
          updated_by: null,
        };
      } else {
        patch = { folio_releido_at: ahora };
      }
      const q = aplicarCas(
        sb
          .from('gasto')
          .update(patch)
          .eq('id', gastoId)
          .is('folio_ticket', null)
          .is('folio_releido_at', null)
          .is('factura_recibida_id', null),
        actual.updated_at,
      );
      const { data: escritas, error: uErr } = await q.select('id');
      if (uErr) {
        if (uErr.code === '23505' && modo === 'FOLIO') {
          modo = 'DUPLICADO';
          continue;
        }
        this.logger.warn(
          `Relectura de folio: no se pudo guardar el gasto ${gastoId}: ${uErr.message}`,
        );
        return 'FALLO';
      }
      if ((escritas ?? []).length > 0) {
        if (modo === 'FOLIO') return 'CON_FOLIO';
        if (modo === 'DUPLICADO') return 'DUPLICADO';
        return decision.tipo === 'ILEGIBLE' ? 'ILEGIBLE' : 'SIN_FOLIO';
      }
      // 0 filas: el gasto cambió entre la relectura y el UPDATE ⇒ otra vuelta.
    }
    this.logger.warn(
      `Relectura de folio: el gasto ${gastoId} cambió durante la corrida (se reintenta)`,
    );
    return 'FALLO';
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { columnaOpcional } from '../../common/columna-opcional.util';
import {
  LIMITE_ARCHIVO_FACTURA_BYTES,
  MENSAJE_VUELO_CON_CFDI,
  bloqueFacturaCliente,
  bloqueaBajarEstatus,
  contentTypeArchivoFactura,
  extraerDatosCfdi,
  normalizarFolioFactura,
  pathArchivoFactura,
  validarArchivoFactura,
  type ArchivoEntrante,
  type BloqueFacturaCliente,
  type EstatusFacturaCliente,
  type VueloFacturaRow,
} from './factura-cliente.util';

/** Bucket PRIVADO donde ya viven los CFDI emitidos y recibidos. */
export const BUCKET_FACTURAS = 'facturas';

/** Vigencia de la URL firmada del archivo (10 min, como pidió el contrato). */
export const SEGUNDOS_URL_FIRMADA = 600;

/** Migración que crea las columnas de la factura del servicio. */
export const MIGRACION_FACTURA_CLIENTE = '20260923000001';

/** Migración del FOLIO de la factura del servicio (24-sep-2026). */
export const MIGRACION_FACTURA_FOLIO = '20260924000001';

const COLS_FACTURA =
  'id, facturado, factura_estatus, factura_archivo_path, factura_archivo_nombre, factura_archivo_subida_at, factura_archivo_subida_por';

/** Columnas de `20260924000001` (se agregan SOLO si la sonda las ve). */
const COLS_FOLIO = 'factura_folio, factura_uuid';

/** Lo mínimo que se lee cuando la migración todavía no está aplicada. */
const COLS_LEGADO = 'id, facturado';

/** Qué migraciones de la factura del servicio están aplicadas. */
interface ColumnasFactura {
  /** `20260923000001`: estatus + archivo. */
  estatus: boolean;
  /** `20260924000001`: folio + UUID (solo cuenta si `estatus` también). */
  folio: boolean;
}

/** Cambio del `PATCH :id/factura-cliente` (al menos uno de los dos). */
export interface CambioFacturaCliente {
  estatus?: EstatusFacturaCliente;
  /** `undefined` = no se toca; `null`/"" = se borra. */
  folio?: string | null;
}

/**
 * FACTURA DEL SERVICIO POR VUELO (22-sep-2026): estatus manual de tres
 * estados + el archivo (PDF/XML) que la oficina sube «a un lado».
 *
 * TOLERANTE A LA MIGRACIÓN PENDIENTE (`20260923000001`): mientras las
 * columnas no existan, **leer** sigue funcionando (el bloque se deriva de
 * `vuelo.facturado`, exactamente lo que el panel pinta hoy) y **escribir**
 * responde un 409 que dice qué falta — nunca un 500 críptico ni, peor, un
 * guardado que se pierde en silencio.
 */
@Injectable()
export class FacturaClienteService {
  private readonly logger = new Logger(FacturaClienteService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** ¿Ya existen las columnas de la migración? (sondeo memorizado ≤ 10 min) */
  private columnasListas(): Promise<boolean> {
    return columnaOpcional(this.supabase.service, 'vuelo', 'factura_estatus', {
      mensajeAusente:
        `Columnas vuelo.factura_* no existen todavía: la factura del servicio ` +
        `se deriva de vuelo.facturado hasta aplicar la migración ${MIGRACION_FACTURA_CLIENTE}`,
    }).disponible();
  }

  /**
   * Las DOS sondas: estatus/archivo (`20260923000001`) y folio/UUID
   * (`20260924000001`). El folio solo cuenta si la primera también está:
   * sin estatus no hay bloque que extender.
   */
  private async columnas(): Promise<ColumnasFactura> {
    const estatus = await this.columnasListas();
    if (!estatus) return { estatus: false, folio: false };
    const folio = await columnaOpcional(
      this.supabase.service,
      'vuelo',
      'factura_folio',
      {
        mensajeAusente:
          `Columnas vuelo.factura_folio/factura_uuid no existen todavía: el ` +
          `folio de la factura del servicio no se guarda hasta aplicar la ` +
          `migración ${MIGRACION_FACTURA_FOLIO}`,
      },
    ).disponible();
    return { estatus, folio };
  }

  private colsFactura(c: ColumnasFactura): string {
    return c.folio ? `${COLS_FACTURA}, ${COLS_FOLIO}` : COLS_FACTURA;
  }

  /** 409 del folio: el archivo y el estatus siguen funcionando como hoy. */
  private folioNoDisponible(): ConflictException {
    return new ConflictException({
      message:
        'El folio de la factura todavía no se puede guardar (falta aplicar ' +
        'una actualización de la base de datos). Sube el archivo o cambia el ' +
        'estatus sin folio, o vuelve a intentarlo en unos minutos; si sigue ' +
        'igual, avisa a soporte.',
      error: 'FACTURA_FOLIO_NO_DISPONIBLE',
      details: { migracion: MIGRACION_FACTURA_FOLIO },
    });
  }

  private noDisponible(): ConflictException {
    return new ConflictException({
      message:
        'La factura del servicio por vuelo todavía no está habilitada en la ' +
        'base de datos (falta aplicar la migración). Vuelve a intentarlo en ' +
        'unos minutos; si sigue igual, avisa a soporte.',
      error: 'FACTURA_CLIENTE_NO_DISPONIBLE',
      details: { migracion: MIGRACION_FACTURA_CLIENTE },
    });
  }

  /** Fila del vuelo con las columnas de factura (o solo las legadas). */
  private async filaVuelo(
    vueloId: string,
    conColumnas: boolean | ColumnasFactura,
  ): Promise<VueloFacturaRow & { id: string }> {
    const c: ColumnasFactura =
      typeof conColumnas === 'boolean'
        ? { estatus: conColumnas, folio: false }
        : conColumnas;
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(c.estatus ? this.colsFactura(c) : COLS_LEGADO)
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new NotFoundException(`Vuelo ${vueloId} not found`);
    return data as unknown as VueloFacturaRow & { id: string };
  }

  /** Nombre de quienes subieron archivos, en UNA consulta. */
  private async nombresUsuarios(
    ids: string[],
  ): Promise<Map<string, string | null>> {
    const limpios = [...new Set(ids.filter(Boolean))];
    if (limpios.length === 0) return new Map();
    const { data, error } = await this.supabase.service
      .from('usuario')
      .select('id, nombre')
      .in('id', limpios);
    if (error) {
      // Un nombre es presentación: nunca tumba la lectura del vuelo.
      this.logger.warn(`No se pudieron resolver nombres: ${error.message}`);
      return new Map();
    }
    return new Map(
      (data ?? []).map((u) => [
        u.id as string,
        (u.nombre as string | null) ?? null,
      ]),
    );
  }

  /**
   * Bloque `factura_cliente` de UN vuelo. `filaConocida` evita releer cuando
   * el caller ya tiene la fila (el snapshot la trae de `findById`).
   */
  async bloqueDeVuelo(
    vueloId: string,
    filaConocida?: VueloFacturaRow | null,
  ): Promise<BloqueFacturaCliente> {
    const cols = await this.columnas();
    if (!cols.estatus) {
      return bloqueFacturaCliente(
        filaConocida ?? (await this.filaVuelo(vueloId, false)),
      );
    }
    const fila = await this.filaVuelo(vueloId, cols);
    const autorId = (fila.factura_archivo_subida_por as string | null) ?? null;
    const nombres = autorId
      ? await this.nombresUsuarios([autorId])
      : new Map<string, string | null>();
    return bloqueFacturaCliente(
      fila,
      autorId ? (nombres.get(autorId) ?? null) : null,
    );
  }

  /**
   * Bloques de VARIOS vuelos (listado): 2 consultas por página como máximo
   * (vuelo + usuario), nunca N+1. `filasBase` son las filas que el listado
   * ya leyó — de ahí sale `facturado` cuando la migración no está aplicada.
   */
  async bloquesDeVuelos(
    filasBase: Array<{ id?: unknown } & VueloFacturaRow>,
  ): Promise<Map<string, BloqueFacturaCliente>> {
    const out = new Map<string, BloqueFacturaCliente>();
    const ids = filasBase
      .map((f) => f.id)
      .filter((x): x is string => typeof x === 'string');
    if (ids.length === 0) return out;
    const cols = await this.columnas();
    if (!cols.estatus) {
      for (const f of filasBase) {
        if (typeof f.id === 'string') out.set(f.id, bloqueFacturaCliente(f));
      }
      return out;
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(this.colsFactura(cols))
      .in('id', ids);
    if (error) {
      // Degradación explícita: el listado no se cae por el bloque nuevo.
      this.logger.warn(
        `No se pudo leer la factura del servicio del lote: ${error.message}`,
      );
      for (const f of filasBase) {
        if (typeof f.id === 'string') out.set(f.id, bloqueFacturaCliente(f));
      }
      return out;
    }
    const filas = (data ?? []) as unknown as Array<
      VueloFacturaRow & { id: string }
    >;
    const nombres = await this.nombresUsuarios(
      filas
        .map((f) => f.factura_archivo_subida_por)
        .filter((x): x is string => typeof x === 'string'),
    );
    for (const f of filas) {
      const autorId = (f.factura_archivo_subida_por as string | null) ?? null;
      out.set(
        f.id,
        bloqueFacturaCliente(f, autorId ? nombres.get(autorId) : null),
      );
    }
    // Vuelos que la consulta no devolvió (carrera con un borrado): se
    // responde lo derivable, nunca un hueco.
    for (const f of filasBase) {
      if (typeof f.id === 'string' && !out.has(f.id)) {
        out.set(f.id, bloqueFacturaCliente(f));
      }
    }
    return out;
  }

  /** Cambia el estatus MANUAL. Con CFDI timbrado no puede bajar (409). */
  setEstatus(
    vueloId: string,
    estatus: EstatusFacturaCliente,
    userId: string,
  ): Promise<BloqueFacturaCliente> {
    return this.actualizar(vueloId, { estatus }, userId);
  }

  /**
   * `PATCH :id/factura-cliente` (24-sep-2026): estatus y/o FOLIO en UNA
   * escritura. El folio se captura o se corrige sin subir archivo — también
   * en los vuelos que ya se marcaron «Facturado» sin papel. Candados:
   *  - sin la migración `20260923000001`: 409 FACTURA_CLIENTE_NO_DISPONIBLE;
   *  - con folio pero sin `20260924000001`: 409 FACTURA_FOLIO_NO_DISPONIBLE
   *    ANTES de escribir nada (ni el estatus: nada a medias);
   *  - CFDI timbrado: el estatus no baja de FACTURADO (409 VUELO_CON_CFDI).
   */
  async actualizar(
    vueloId: string,
    cambio: CambioFacturaCliente,
    userId: string,
  ): Promise<BloqueFacturaCliente> {
    const tocaEstatus = cambio.estatus !== undefined;
    const tocaFolio = cambio.folio !== undefined;
    if (!tocaEstatus && !tocaFolio) {
      throw new BadRequestException(
        'Manda el estatus o el folio de la factura (o los dos).',
      );
    }
    const cols = await this.columnas();
    if (!cols.estatus) throw this.noDisponible();
    if (tocaFolio && !cols.folio) throw this.folioNoDisponible();
    const fila = await this.filaVuelo(vueloId, cols);
    if (tocaEstatus && bloqueaBajarEstatus(fila, cambio.estatus!)) {
      throw new ConflictException({
        message: MENSAJE_VUELO_CON_CFDI,
        error: 'VUELO_CON_CFDI',
        details: { vuelo_id: vueloId, estatus_actual: 'FACTURADO' },
      });
    }
    const patch: Record<string, unknown> = { updated_by: userId };
    if (tocaEstatus) patch.factura_estatus = cambio.estatus;
    if (tocaFolio) patch.factura_folio = normalizarFolioFactura(cambio.folio);
    const { error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', vueloId);
    if (error) throw new Error(error.message);
    return this.bloqueDeVuelo(vueloId);
  }

  /**
   * Sube (o reemplaza) el archivo de la factura del servicio. Orden a
   * propósito: primero se sube el archivo NUEVO, luego se guarda su path y
   * solo al final se borra el anterior — así ningún fallo deja al vuelo
   * apuntando a un archivo que ya no existe.
   */
  async subirArchivo(
    vueloId: string,
    archivo: ArchivoEntrante,
    userId: string,
    opts: { folio?: string | null } = {},
  ): Promise<BloqueFacturaCliente> {
    const cols = await this.columnas();
    if (!cols.estatus) throw this.noDisponible();
    const v = validarArchivoFactura({
      nombre: archivo.nombre,
      mime: archivo.mime,
      bytes: archivo.buffer.length,
    });
    if (!v.ok) {
      const cuerpo = { message: v.mensaje, error: v.codigo };
      if (v.codigo === 'ARCHIVO_MUY_GRANDE') {
        throw new PayloadTooLargeException({
          ...cuerpo,
          details: {
            bytes: archivo.buffer.length,
            limite_bytes: LIMITE_ARCHIVO_FACTURA_BYTES,
          },
        });
      }
      throw new BadRequestException(cuerpo);
    }
    // FOLIO (24-sep-2026): el TECLEADO gana; si no, el del XML del CFDI
    // (`SERIE-FOLIO` + UUID). Tecleado sin la migración del folio ⇒ 409
    // ANTES de subir nada (jamás un folio que se pierde en silencio); el
    // extraído sin la migración simplemente no se guarda (sigue en el XML).
    const folioTecleado = normalizarFolioFactura(opts.folio);
    if (folioTecleado && !cols.folio) throw this.folioNoDisponible();
    const cfdi =
      v.extension === 'xml' ? extraerDatosCfdi(archivo.buffer) : null;
    const folioFinal = folioTecleado ?? cfdi?.etiqueta ?? null;
    const fila = await this.filaVuelo(vueloId, cols);

    const path = pathArchivoFactura(vueloId, randomUUID(), v.extension);
    const { error: upErr } = await this.supabase.service.storage
      .from(BUCKET_FACTURAS)
      .upload(path, archivo.buffer, {
        contentType: contentTypeArchivoFactura(v.extension),
        upsert: false,
      });
    if (upErr) {
      throw new Error(`No se pudo guardar la factura: ${upErr.message}`);
    }

    const patch: Record<string, unknown> = {
      factura_archivo_path: path,
      factura_archivo_nombre: v.nombre,
      factura_archivo_subida_at: new Date().toISOString(),
      factura_archivo_subida_por: userId,
      updated_by: userId,
    };
    if (cols.folio) {
      // Sin folio nuevo (PDF sin teclear) se CONSERVA el que ya tenía: un
      // reemplazo del papel no borra un dato que alguien capturó. El UUID
      // solo cambia cuando llega un XML (es del CFDI, no del PDF).
      if (folioFinal) patch.factura_folio = folioFinal;
      if (v.extension === 'xml') patch.factura_uuid = cfdi?.uuid ?? null;
    }
    const { error } = await this.supabase.service
      .from('vuelo')
      .update(patch)
      .eq('id', vueloId);
    if (error) {
      // El archivo quedó huérfano: se retira para no dejar basura privada.
      await this.borrarDelBucket([path]);
      throw new Error(error.message);
    }

    const anterior = (fila.factura_archivo_path as string | null) ?? null;
    if (anterior && anterior !== path) await this.borrarDelBucket([anterior]);
    return this.bloqueDeVuelo(vueloId);
  }

  /** Quita el archivo (el estatus NO se toca: son dos decisiones distintas). */
  async quitarArchivo(
    vueloId: string,
    userId: string,
  ): Promise<BloqueFacturaCliente> {
    if (!(await this.columnasListas())) throw this.noDisponible();
    const fila = await this.filaVuelo(vueloId, true);
    const path = (fila.factura_archivo_path as string | null) ?? null;
    if (!path) {
      throw new NotFoundException(
        'Este vuelo no tiene archivo de factura que quitar.',
      );
    }
    const { error } = await this.supabase.service
      .from('vuelo')
      .update({
        factura_archivo_path: null,
        factura_archivo_nombre: null,
        factura_archivo_subida_at: null,
        factura_archivo_subida_por: null,
        updated_by: userId,
      })
      .eq('id', vueloId);
    if (error) throw new Error(error.message);
    await this.borrarDelBucket([path]);
    return this.bloqueDeVuelo(vueloId);
  }

  /** URL firmada 10 min del archivo (el bucket es PRIVADO). */
  async archivoUrl(vueloId: string): Promise<{ url: string }> {
    const conColumnas = await this.columnasListas();
    if (!conColumnas) {
      throw new NotFoundException(
        'Este vuelo no tiene archivo de factura adjunto.',
      );
    }
    const fila = await this.filaVuelo(vueloId, true);
    const path = (fila.factura_archivo_path as string | null) ?? null;
    if (!path) {
      throw new NotFoundException(
        'Este vuelo no tiene archivo de factura adjunto.',
      );
    }
    const { data, error } = await this.supabase.service.storage
      .from(BUCKET_FACTURAS)
      .createSignedUrl(path, SEGUNDOS_URL_FIRMADA);
    if (error || !data?.signedUrl) {
      throw new NotFoundException(
        `No se pudo firmar el archivo: ${error?.message ?? 'sin URL'}`,
      );
    }
    return { url: data.signedUrl };
  }

  /**
   * Al TIMBRAR un CFDI el vuelo pasa a FACTURADO. Best-effort a propósito:
   * el timbrado ya se concretó (y `vuelo.facturado` ya quedó en true, que es
   * lo que manda en la derivación) — un fallo aquí no puede tumbar la
   * emisión ni dejar la factura sin registrar.
   */
  async marcarFacturadoPorCfdi(vueloId: string, userId: string): Promise<void> {
    try {
      if (!(await this.columnasListas())) return;
      const { error } = await this.supabase.service
        .from('vuelo')
        .update({ factura_estatus: 'FACTURADO', updated_by: userId })
        .eq('id', vueloId);
      if (error) throw new Error(error.message);
    } catch (e) {
      this.logger.warn(
        `Vuelo ${vueloId} timbrado pero no se pudo marcar factura_estatus=FACTURADO: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private async borrarDelBucket(paths: string[]): Promise<void> {
    const { error } = await this.supabase.service.storage
      .from(BUCKET_FACTURAS)
      .remove(paths);
    if (error) {
      this.logger.warn(
        `No se pudo borrar ${paths.join(', ')} del bucket ${BUCKET_FACTURAS}: ${error.message}`,
      );
    }
  }
}

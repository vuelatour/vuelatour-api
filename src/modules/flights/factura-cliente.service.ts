import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { columnaOpcional } from '../../common/columna-opcional.util';
import {
  MENSAJE_VUELO_CON_CFDI,
  bloqueFacturaCliente,
  bloqueaBajarEstatus,
  contentTypeArchivoFactura,
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

const COLS_FACTURA =
  'id, facturado, factura_estatus, factura_archivo_path, factura_archivo_nombre, factura_archivo_subida_at, factura_archivo_subida_por';

/** Lo mínimo que se lee cuando la migración todavía no está aplicada. */
const COLS_LEGADO = 'id, facturado';

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
    conColumnas: boolean,
  ): Promise<VueloFacturaRow & { id: string }> {
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(conColumnas ? COLS_FACTURA : COLS_LEGADO)
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
    const conColumnas = await this.columnasListas();
    if (!conColumnas) {
      return bloqueFacturaCliente(
        filaConocida ?? (await this.filaVuelo(vueloId, false)),
      );
    }
    const fila = await this.filaVuelo(vueloId, true);
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
    if (!(await this.columnasListas())) {
      for (const f of filasBase) {
        if (typeof f.id === 'string') out.set(f.id, bloqueFacturaCliente(f));
      }
      return out;
    }
    const { data, error } = await this.supabase.service
      .from('vuelo')
      .select(COLS_FACTURA)
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
  async setEstatus(
    vueloId: string,
    estatus: EstatusFacturaCliente,
    userId: string,
  ): Promise<BloqueFacturaCliente> {
    if (!(await this.columnasListas())) throw this.noDisponible();
    const fila = await this.filaVuelo(vueloId, true);
    if (bloqueaBajarEstatus(fila, estatus)) {
      throw new ConflictException({
        message: MENSAJE_VUELO_CON_CFDI,
        error: 'VUELO_CON_CFDI',
        details: { vuelo_id: vueloId, estatus_actual: 'FACTURADO' },
      });
    }
    const { error } = await this.supabase.service
      .from('vuelo')
      .update({ factura_estatus: estatus, updated_by: userId })
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
  ): Promise<BloqueFacturaCliente> {
    if (!(await this.columnasListas())) throw this.noDisponible();
    const fila = await this.filaVuelo(vueloId, true);
    const v = validarArchivoFactura({
      nombre: archivo.nombre,
      mime: archivo.mime,
      bytes: archivo.buffer.length,
    });
    if (!v.ok) throw new BadRequestException(v.mensaje);

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

    const { error } = await this.supabase.service
      .from('vuelo')
      .update({
        factura_archivo_path: path,
        factura_archivo_nombre: v.nombre,
        factura_archivo_subida_at: new Date().toISOString(),
        factura_archivo_subida_por: userId,
        updated_by: userId,
      })
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

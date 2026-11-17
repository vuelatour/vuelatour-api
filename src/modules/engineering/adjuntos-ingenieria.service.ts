import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BUCKET_ADJUNTOS_INGENIERIA,
  MIGRACION_INGENIERIA_COMPONENTES,
  TABLA_ADJUNTO_INGENIERIA,
  TABLA_COMPONENTE_AERONAVE,
} from '../../common/adjuntos-ingenieria.util';
import {
  columnaOpcional,
  esTablaInexistente,
} from '../../common/columna-opcional.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ETIQUETAS_ADJUNTO,
  type CreateAdjuntoDto,
  type DestinoAdjunto,
  type EtiquetaAdjunto,
} from './dto/componentes.dto';
import { leerPaginado } from './leer-paginado.util';

/**
 * ARCHIVOS DE INGENIERÍA (17-nov-2026, API 0.0.140, invariante 135). Pedido
 * del cliente: «cada que se le da un mantenimiento el taller te entrega un
 * sticker […] la idea es que le tomen foto y lo suban, o el PDF […] poder
 * descargarlas una vez que ya las hayan subido» y «poder subir uno o varios
 * documentos por componente».
 *
 * El navegador sube el archivo al bucket PRIVADO `documentos-flota` (mismo
 * camino que los permisos y los seguros) y aquí solo se REGISTRA: a qué
 * pertenece (un mantenimiento, un componente, un motor o una hélice), su
 * nombre y su llave. La llave (`storage_path`) NUNCA sale del API: el archivo
 * se ve y se baja con una URL firmada de corta vida.
 */

/** Tope de archivos ACTIVOS por destino. */
export const TOPE_ADJUNTOS_POR_DESTINO = 20;
/** Vigencia de la URL firmada (ver / descargar). */
export const SEGUNDOS_URL_ADJUNTO = 600;

type Fila = Record<string, unknown>;
type ColumnaDestino =
  | 'mantenimiento_id'
  | 'componente_id'
  | 'motor_id'
  | 'helice_id';

const ADJ_COLS =
  'id, aeronave_id, mantenimiento_id, componente_id, motor_id, helice_id, storage_path, nombre, mime, bytes, etiqueta, nota, subido_por, created_at';

const COLUMNA_DE_DESTINO: Record<DestinoAdjunto, ColumnaDestino> = {
  MANTENIMIENTO: 'mantenimiento_id',
  COMPONENTE: 'componente_id',
  MOTOR: 'motor_id',
  HELICE: 'helice_id',
};

const TABLA_DE_DESTINO: Record<DestinoAdjunto, string> = {
  MANTENIMIENTO: 'mantenimiento',
  COMPONENTE: TABLA_COMPONENTE_AERONAVE,
  MOTOR: 'motor',
  HELICE: 'helice',
};

const NOMBRE_DE_DESTINO: Record<DestinoAdjunto, string> = {
  MANTENIMIENTO: 'el mantenimiento',
  COMPONENTE: 'el componente',
  MOTOR: 'el motor',
  HELICE: 'la hélice',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdjuntoIngenieria {
  id: string;
  destino: DestinoAdjunto;
  destino_id: string;
  aeronave_id: string | null;
  nombre: string;
  mime: string;
  bytes: number;
  etiqueta: EtiquetaAdjunto | null;
  nota: string | null;
  subido_por_nombre: string | null;
  created_at: string;
}

export interface AdjuntosDeAeronave {
  /** `false` = la migración 20261117000001 todavía no está aplicada. */
  disponible: boolean;
  adjuntos: AdjuntoIngenieria[];
}

export interface UrlAdjunto {
  url: string;
  expira_en_s: number;
  nombre: string;
  mime: string;
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Nombre seguro para `download=` de la URL firmada: storage-js lo pega tal
 * cual en la query, así que un `&`, `#` o `?` del nombre original la rompería.
 */
export function nombreDeDescarga(nombre: string): string {
  const limpio = nombre
    .replace(/[\\/:*?"<>|#&%+;=]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > 0 ? limpio : 'archivo';
}

@Injectable()
export class AdjuntosIngenieriaService {
  constructor(private readonly supabase: SupabaseService) {}

  // ===== Migración 20261117000001 =====
  // Sonda ÚNICA de la tabla: mientras no exista, las lecturas responden
  // `disponible: false` y las escrituras 503 MIGRACION_PENDIENTE. Se enciende
  // sola en ≤ 10 min al aplicarla, sin reiniciar el API.

  private disponible(): Promise<boolean> {
    return columnaOpcional(
      this.supabase.service,
      TABLA_ADJUNTO_INGENIERIA,
      'id',
      {
        tambienTabla: true,
        mensajeAusente: `Tabla ${TABLA_ADJUNTO_INGENIERIA} no existe todavía: archivos de ingeniería apagados hasta aplicar la migración ${MIGRACION_INGENIERIA_COMPONENTES}`,
      },
    ).disponible();
  }

  private migracionPendiente(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      message:
        'Los archivos de mantenimiento todavía no están disponibles: falta aplicar una actualización de la base de datos. Avisa a sistemas.',
      error: 'MIGRACION_PENDIENTE',
      details: { migracion: MIGRACION_INGENIERIA_COMPONENTES },
    });
  }

  private async exigirDisponible(): Promise<void> {
    if (!(await this.disponible())) throw this.migracionPendiente();
  }

  private noEncontrado(id: string): NotFoundException {
    return new NotFoundException({
      message: 'Ese archivo ya no existe o fue eliminado.',
      error: 'ADJUNTO_NO_ENCONTRADO',
      details: { id },
    });
  }

  private aRespuesta(f: Fila, nombres: Map<string, string>): AdjuntoIngenieria {
    const destino: DestinoAdjunto = f.mantenimiento_id
      ? 'MANTENIMIENTO'
      : f.componente_id
        ? 'COMPONENTE'
        : f.motor_id
          ? 'MOTOR'
          : 'HELICE';
    const etiqueta = texto(f.etiqueta);
    const subidoPor = texto(f.subido_por);
    return {
      id: f.id as string,
      destino,
      destino_id: f[COLUMNA_DE_DESTINO[destino]] as string,
      aeronave_id: texto(f.aeronave_id),
      nombre: texto(f.nombre) ?? 'archivo',
      mime: texto(f.mime) ?? 'application/octet-stream',
      bytes: Number(f.bytes ?? 0),
      etiqueta: (ETIQUETAS_ADJUNTO as readonly string[]).includes(
        etiqueta ?? '',
      )
        ? (etiqueta as EtiquetaAdjunto)
        : null,
      nota: texto(f.nota),
      subido_por_nombre: subidoPor ? (nombres.get(subidoPor) ?? null) : null,
      created_at: f.created_at as string,
    };
  }

  /**
   * Archivos ACTIVOS del avión: los de sus mantenimientos, los de sus
   * componentes (instalados y retirados, no los eliminados) y los de los
   * motores y hélices que HOY están en el avión (un motor trasladado se
   * lleva sus archivos). Más reciente primero.
   */
  async listarDeAeronave(aeronaveId: string): Promise<AdjuntosDeAeronave> {
    if (!UUID_RE.test(aeronaveId)) {
      throw new BadRequestException('Id de aeronave inválido');
    }
    const sinMigracion: AdjuntosDeAeronave = {
      disponible: false,
      adjuntos: [],
    };
    if (!(await this.disponible())) return sinMigracion;
    const sb = this.supabase.service;
    const [componentes, motores, helices] = await Promise.all([
      leerPaginado<Fila>((desde, hasta) =>
        sb
          .from(TABLA_COMPONENTE_AERONAVE)
          .select('id')
          .eq('aeronave_id', aeronaveId)
          .is('eliminado_at', null)
          .order('id', { ascending: true })
          .range(desde, hasta),
      ),
      sb.from('motor').select('id').eq('aeronave_id', aeronaveId),
      sb.from('helice').select('id').eq('aeronave_id', aeronaveId),
    ]);
    if (componentes.error) {
      if (esTablaInexistente(componentes.error)) return sinMigracion;
      throw new Error(componentes.error.message);
    }
    if (motores.error) throw new Error(motores.error.message);
    if (helices.error) throw new Error(helices.error.message);
    const ids = (filas: unknown): Set<string> =>
      new Set(
        ((filas ?? []) as Fila[])
          .map((f) => texto(f.id))
          .filter((x): x is string => !!x && UUID_RE.test(x)),
      );
    const idsComponente = ids(componentes.filas);
    const idsMotor = ids(motores.data);
    const idsHelice = ids(helices.data);

    // Solo uuids entran al texto del filtro (los del avión vienen de la BD).
    const partes = [`aeronave_id.eq.${aeronaveId}`];
    if (idsMotor.size > 0) {
      partes.push(`motor_id.in.(${[...idsMotor].join(',')})`);
    }
    if (idsHelice.size > 0) {
      partes.push(`helice_id.in.(${[...idsHelice].join(',')})`);
    }
    const leidas = await leerPaginado<Fila>((desde, hasta) =>
      sb
        .from(TABLA_ADJUNTO_INGENIERIA)
        .select(ADJ_COLS)
        .is('eliminado_at', null)
        .or(partes.join(','))
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(desde, hasta),
    );
    if (leidas.error) {
      if (esTablaInexistente(leidas.error)) return sinMigracion;
      throw new Error(leidas.error.message);
    }
    // El filtro trae de más a propósito (todo lo subido en este avión): aquí
    // se queda solo lo que HOY le pertenece.
    const vivos = leidas.filas.filter((f) => {
      if (f.mantenimiento_id) return f.aeronave_id === aeronaveId;
      if (f.componente_id) return idsComponente.has(f.componente_id as string);
      if (f.motor_id) return idsMotor.has(f.motor_id as string);
      if (f.helice_id) return idsHelice.has(f.helice_id as string);
      return false;
    });
    const nombres = await fetchNombresUsuarios(
      sb,
      vivos.map((f) => texto(f.subido_por)),
    );
    return {
      disponible: true,
      adjuntos: vivos.map((f) => this.aRespuesta(f, nombres)),
    };
  }

  /** El destino existe (y, si es un componente, no está eliminado). */
  private async aeronaveDelDestino(
    destino: DestinoAdjunto,
    destinoId: string,
  ): Promise<string | null> {
    const esComponente = destino === 'COMPONENTE';
    const { data, error } = await this.supabase.service
      .from(TABLA_DE_DESTINO[destino])
      .select(
        esComponente ? 'id, aeronave_id, eliminado_at' : 'id, aeronave_id',
      )
      .eq('id', destinoId)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw this.migracionPendiente();
      throw new Error(error.message);
    }
    const fila = data as Fila | null;
    if (!fila || (esComponente && fila.eliminado_at != null)) {
      throw this.destinoNoEncontrado(destino, destinoId);
    }
    return texto(fila.aeronave_id);
  }

  private destinoNoEncontrado(
    destino: DestinoAdjunto,
    destinoId: string,
  ): NotFoundException {
    return new NotFoundException({
      message: `No se encontró ${NOMBRE_DE_DESTINO[destino]} al que quieres adjuntar el archivo. Recarga la página.`,
      error: 'DESTINO_NO_ENCONTRADO',
      details: { destino, destino_id: destinoId },
    });
  }

  private yaRegistrado(): ConflictException {
    return new ConflictException({
      message: 'Ese archivo ya estaba registrado.',
      error: 'ARCHIVO_YA_REGISTRADO',
    });
  }

  /**
   * El objeto DEBE existir en el bucket antes de registrarlo: firmarlo falla
   * si no está. Un «no existe» es 400 `ARCHIVO_NO_ENCONTRADO`; cualquier otra
   * falla de Storage es 503 (no se le dice «no existe» a un archivo que sí
   * se subió).
   */
  private async exigirArchivoEnBucket(path: string): Promise<void> {
    let error: {
      message?: string;
      status?: number | string;
      statusCode?: number | string;
    } | null = null;
    let url: string | undefined;
    try {
      const res = await this.supabase.service.storage
        .from(BUCKET_ADJUNTOS_INGENIERIA)
        .createSignedUrl(path, 60);
      error = res.error;
      url = res.data?.signedUrl;
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) };
    }
    if (!error && url) return;
    const mensaje = (error?.message ?? '').toLowerCase();
    const estado = `${error?.status ?? ''} ${error?.statusCode ?? ''}`;
    const noExiste =
      !error ||
      /not.?found|does not exist|no such|no existe/.test(mensaje) ||
      /\b(400|404)\b/.test(estado);
    if (noExiste) {
      throw new BadRequestException({
        message:
          'El archivo no llegó al almacenamiento. Vuelve a subirlo; si se repite, avisa a sistemas.',
        error: 'ARCHIVO_NO_ENCONTRADO',
        details: { tecnico: error?.message ?? 'sin URL firmada' },
      });
    }
    throw new ServiceUnavailableException({
      message:
        'No se pudo verificar el archivo en este momento; vuelve a intentarlo.',
      error: 'STORAGE_NO_DISPONIBLE',
      details: { tecnico: error?.message ?? null },
    });
  }

  /** Registra un archivo YA subido al bucket. */
  async registrar(
    dto: CreateAdjuntoDto,
    userId: string,
  ): Promise<AdjuntoIngenieria> {
    await this.exigirDisponible();
    const sb = this.supabase.service;
    const columna = COLUMNA_DE_DESTINO[dto.destino];
    const aeronaveId = await this.aeronaveDelDestino(
      dto.destino,
      dto.destino_id,
    );

    const previo = await sb
      .from(TABLA_ADJUNTO_INGENIERIA)
      .select('id')
      .eq('storage_path', dto.storage_path)
      .limit(1);
    if (previo.error) {
      if (esTablaInexistente(previo.error)) throw this.migracionPendiente();
      throw new Error(previo.error.message);
    }
    if (((previo.data ?? []) as Fila[]).length > 0) throw this.yaRegistrado();

    const activos = await sb
      .from(TABLA_ADJUNTO_INGENIERIA)
      .select('id')
      .eq(columna, dto.destino_id)
      .is('eliminado_at', null)
      .limit(TOPE_ADJUNTOS_POR_DESTINO + 1);
    if (activos.error) throw new Error(activos.error.message);
    if (((activos.data ?? []) as Fila[]).length >= TOPE_ADJUNTOS_POR_DESTINO) {
      throw new ConflictException({
        message: `Ya hay ${TOPE_ADJUNTOS_POR_DESTINO} archivos en ${NOMBRE_DE_DESTINO[dto.destino]}: quita alguno antes de subir otro.`,
        error: 'TOPE_ADJUNTOS',
        details: { tope: TOPE_ADJUNTOS_POR_DESTINO },
      });
    }

    await this.exigirArchivoEnBucket(dto.storage_path);

    const nota = (dto.nota ?? '').trim();
    const { data, error } = await sb
      .from(TABLA_ADJUNTO_INGENIERIA)
      .insert({
        aeronave_id: aeronaveId,
        [columna]: dto.destino_id,
        storage_path: dto.storage_path,
        nombre: dto.nombre.trim(),
        mime: dto.mime,
        bytes: dto.bytes,
        etiqueta: dto.etiqueta ?? null,
        nota: nota.length > 0 ? nota : null,
        subido_por: userId,
      })
      .select(ADJ_COLS)
      .maybeSingle();
    if (error) {
      // Carrera con otro registro del mismo archivo (índice único).
      if (error.code === '23505') throw this.yaRegistrado();
      // El destino se fue entre la lectura y el alta.
      if (error.code === '23503') {
        throw this.destinoNoEncontrado(dto.destino, dto.destino_id);
      }
      if (error.code === '23514') {
        throw new BadRequestException({
          message: 'Alguno de los datos del archivo no es válido.',
          error: 'ADJUNTO_INVALIDO',
          details: { tecnico: error.message },
        });
      }
      if (esTablaInexistente(error)) throw this.migracionPendiente();
      throw new Error(error.message);
    }
    if (!data) throw new Error('El archivo no se pudo registrar');
    const nombres = await fetchNombresUsuarios(sb, [userId]);
    return this.aRespuesta(data, nombres);
  }

  /** URL firmada (10 min) para VER el archivo o, con `descargar`, bajarlo. */
  async url(id: string, descargar: boolean): Promise<UrlAdjunto> {
    if (!(await this.disponible())) throw this.noEncontrado(id);
    const { data, error } = await this.supabase.service
      .from(TABLA_ADJUNTO_INGENIERIA)
      .select('id, storage_path, nombre, mime')
      .eq('id', id)
      .is('eliminado_at', null)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw this.noEncontrado(id);
      throw new Error(error.message);
    }
    const fila = data as Fila | null;
    const path = texto(fila?.storage_path);
    if (!fila || !path) throw this.noEncontrado(id);
    const nombre = texto(fila.nombre) ?? 'archivo';
    const { data: firmado, error: errFirma } =
      await this.supabase.service.storage
        .from(BUCKET_ADJUNTOS_INGENIERIA)
        .createSignedUrl(
          path,
          SEGUNDOS_URL_ADJUNTO,
          descargar ? { download: nombreDeDescarga(nombre) } : undefined,
        );
    if (errFirma || !firmado?.signedUrl) {
      throw new ServiceUnavailableException({
        message: 'No se pudo preparar el archivo en este momento; reintenta.',
        error: 'FIRMA_NO_DISPONIBLE',
        details: { tecnico: errFirma?.message ?? 'sin URL' },
      });
    }
    return {
      url: firmado.signedUrl,
      expira_en_s: SEGUNDOS_URL_ADJUNTO,
      nombre,
      mime: texto(fila.mime) ?? 'application/octet-stream',
    };
  }

  /** Baja con sello: la fila y el archivo del bucket se CONSERVAN. */
  async eliminar(id: string, userId: string): Promise<{ ok: true }> {
    await this.exigirDisponible();
    const { data, error } = await this.supabase.service
      .from(TABLA_ADJUNTO_INGENIERIA)
      .update({ eliminado_at: new Date().toISOString(), eliminado_por: userId })
      .eq('id', id)
      .is('eliminado_at', null)
      .select('id')
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw this.migracionPendiente();
      throw new Error(error.message);
    }
    if (!data) throw this.noEncontrado(id);
    return { ok: true };
  }
}

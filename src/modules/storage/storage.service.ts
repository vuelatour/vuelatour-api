import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { SEGUNDOS_URL_MINIATURA } from '../../common/url-firmada.util';
import type { Rol } from '../../common/types/auth.types';
import { validarSolicitudFirma } from './storage-firma.util';

export interface RespuestaFirma {
  /** path ⇒ URL firmada. Un path que no existe en el bucket NO aparece. */
  urls: Record<string, string>;
  /** Vigencia de cada URL, en segundos desde que se firmó. */
  expira_en_s: number;
}

@Injectable()
export class StorageService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Firma (8 h, `SEGUNDOS_URL_MINIATURA`) archivos de UN bucket de la lista
   * blanca — el refresco de miniaturas del panel (ver `storage-firma.util`).
   * Un path inexistente simplemente no aparece en `urls` (el panel pinta el
   * placeholder); una falla de Storage para TODO el lote es 503
   * `FIRMA_NO_DISPONIBLE` (el panel ofrece «Reintentar»).
   */
  async firmar(
    rol: Rol,
    bucket: string,
    paths: readonly string[],
  ): Promise<RespuestaFirma> {
    const v = validarSolicitudFirma(rol, bucket, paths);
    if (!v.ok) {
      const cuerpo = { message: v.message, error: v.code, details: v.details };
      throw v.status === 403
        ? new ForbiddenException(cuerpo)
        : new BadRequestException(cuerpo);
    }
    if (v.paths.length === 0) {
      return { urls: {}, expira_en_s: SEGUNDOS_URL_MINIATURA };
    }
    const { data, error } = await this.supabase.service.storage
      .from(v.bucket)
      .createSignedUrls(v.paths, SEGUNDOS_URL_MINIATURA);
    if (error) {
      // El filtro global registra el 5xx con `details` (bucket + técnico).
      throw new ServiceUnavailableException({
        message: 'No se pudo preparar la foto en este momento; reintenta.',
        error: 'FIRMA_NO_DISPONIBLE',
        details: { bucket: v.bucket, tecnico: error.message },
      });
    }
    const pedidos = new Set(v.paths);
    const urls: Record<string, string> = {};
    for (const it of data ?? []) {
      if (it.signedUrl && it.path && pedidos.has(it.path)) {
        urls[it.path] = it.signedUrl;
      }
    }
    return { urls, expira_en_s: SEGUNDOS_URL_MINIATURA };
  }
}

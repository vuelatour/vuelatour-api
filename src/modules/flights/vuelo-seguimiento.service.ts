import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { esTablaInexistente } from '../inventory/eliminar-movimiento.util';
import {
  COLS_SEGUIMIENTO,
  CONTADORES_EN_CERO,
  MIGRACION_VUELO_SEGUIMIENTO,
  aNota,
  contarPendientes,
  detallePendientesCotizacion,
  idsUsuariosDeNotas,
  normalizarTexto,
  ordenarNotas,
  parcheSeguimiento,
  type CambiosSeguimiento,
  type ContadoresSeguimiento,
  type NotaSeguimiento,
  type SeguimientoPendienteDetalle,
  type SeguimientoRow,
} from './vuelo-seguimiento.util';

/** Contadores con `null` cuando la lectura FALLÓ (≠ «no hay notas»). */
export type ContadoresSeguimientoONulos = {
  [K in keyof ContadoresSeguimiento]: number | null;
};

/** Bloque ADITIVO de la cotización (`GET /v1/quotes/:id`). */
export type SeguimientoDeCotizacion = ContadoresSeguimientoONulos & {
  seguimiento_pendientes_detalle: SeguimientoPendienteDetalle[];
};

const CONTADORES_NULOS: Readonly<ContadoresSeguimientoONulos> = Object.freeze({
  seguimiento_pendientes: null,
  seguimiento_cotizacion_pendientes: null,
});

/** 503 estructurado: la migración 20260929000002 aún no está aplicada. */
export function errorSeguimientoNoDisponible(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    message:
      'El seguimiento de la cotización todavía no está habilitado en la base de datos (falta aplicar una actualización). Vuelve a intentarlo en unos minutos; si sigue igual, avisa a soporte.',
    error: 'SEGUIMIENTO_NO_DISPONIBLE',
    details: { migracion: MIGRACION_VUELO_SEGUIMIENTO },
  });
}

function vueloNoExiste(id: string): NotFoundException {
  return new NotFoundException({
    message: `Vuelo ${id} not found`,
    error: 'VUELO_NO_EXISTE',
    details: { vuelo_id: id },
  });
}

function notaNoExiste(id: string): NotFoundException {
  return new NotFoundException({
    message: 'La nota de seguimiento no existe o ya se eliminó.',
    error: 'SEGUIMIENTO_NO_EXISTE',
    details: { nota_id: id },
  });
}

/**
 * SEGUIMIENTO DE LA COTIZACIÓN por vuelo (29-sep-2026): notas con estado
 * PENDIENTE/RESUELTA que la oficina deja en el detalle del vuelo para no
 * olvidar ajustes que se deben cobrar o agregar a la cotización. Reglas
 * puras en `vuelo-seguimiento.util.ts`.
 *
 * Provider de `FlightsModule` (exportado para `QuotesService`); NO inyecta
 * `FlightsService` (sin ciclos). Sin la migración `20260929000002` (tabla
 * ausente): la lista responde `[]`, los contadores 0 (no existe ninguna
 * nota) y las escrituras 503 `SEGUIMIENTO_NO_DISPONIBLE`. Cualquier OTRO
 * error de lectura en los bloques ADITIVOS se degrada a `null` con `warn`
 * (el detalle del vuelo y el cotizador no se caen por una lectura accesoria;
 * `null` ≠ 0: jamás se afirma «no hay pendientes» por una lectura fallida).
 */
@Injectable()
export class VueloSeguimientoService {
  private readonly logger = new Logger(VueloSeguimientoService.name);

  constructor(private readonly supabase: SupabaseService) {}

  private get sb() {
    return this.supabase.service;
  }

  /** 404 estructurado si el vuelo no existe. */
  private async assertVuelo(vueloId: string): Promise<void> {
    const { data, error } = await this.sb
      .from('vuelo')
      .select('id')
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw vueloNoExiste(vueloId);
  }

  /** Nota VIVA (no borrada) o 404; tabla ausente ⇒ 503. */
  private async notaViva(notaId: string): Promise<SeguimientoRow> {
    const { data, error } = await this.sb
      .from('vuelo_seguimiento')
      .select(COLS_SEGUIMIENTO)
      .eq('id', notaId)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw errorSeguimientoNoDisponible();
      throw new Error(error.message);
    }
    if (!data) throw notaNoExiste(notaId);
    return data;
  }

  private async conNombres(
    filas: ReadonlyArray<SeguimientoRow>,
  ): Promise<NotaSeguimiento[]> {
    const nombres = await fetchNombresUsuarios(
      this.sb,
      idsUsuariosDeNotas(filas),
    );
    return ordenarNotas(filas).map((f) => aNota(f, nombres));
  }

  /**
   * `GET /v1/flights/:id/seguimiento`: notas NO borradas, PENDIENTE primero
   * y luego la más reciente. 404 si el vuelo no existe.
   */
  async listar(vueloId: string): Promise<NotaSeguimiento[]> {
    await this.assertVuelo(vueloId);
    const { data, error } = await this.sb
      .from('vuelo_seguimiento')
      .select(COLS_SEGUIMIENTO)
      .eq('vuelo_id', vueloId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      if (esTablaInexistente(error)) {
        this.logger.warn(
          `vuelo_seguimiento no existe todavía (migración ${MIGRACION_VUELO_SEGUIMIENTO}): la lista responde vacía.`,
        );
        return [];
      }
      throw new Error(error.message);
    }
    return this.conNombres(data ?? []);
  }

  /** `POST /v1/flights/:id/seguimiento` → la nota creada (PENDIENTE). */
  async crear(
    vueloId: string,
    dto: { texto: string; afecta_cotizacion?: boolean },
    userId: string,
  ): Promise<NotaSeguimiento> {
    const texto = normalizarTexto(dto.texto);
    await this.assertVuelo(vueloId);
    const { data, error } = await this.sb
      .from('vuelo_seguimiento')
      .insert({
        vuelo_id: vueloId,
        texto,
        afecta_cotizacion: dto.afecta_cotizacion ?? true,
        created_by: userId,
      })
      .select(COLS_SEGUIMIENTO)
      .single();
    if (error) {
      if (esTablaInexistente(error)) throw errorSeguimientoNoDisponible();
      // Carrera: el vuelo se purgó entre la validación y el insert.
      if (error.code === '23503') throw vueloNoExiste(vueloId);
      throw new Error(error.message);
    }
    const [nota] = await this.conNombres([data]);
    return nota;
  }

  /**
   * `PATCH /v1/flights/seguimiento/:notaId`: texto / afecta / estado /
   * resolución. RESUELTA sella quién y cuándo; PENDIENTE (reabrir) los
   * limpia. Pedir el estado que ya tiene responde la nota tal cual.
   *
   * CAS por `estado` (revisión adversaria 29-sep-2026): el parche se calcula
   * sobre el estado LEÍDO, así que el UPDATE exige que siga siendo ése. Sin
   * él, dos personas que marcan «resuelta» a la vez re-sellaban (la segunda
   * pisaba quién/cuándo y BORRABA la resolución de la primera con su
   * `resolucion: null`), y corregir la resolución de una nota que otra
   * persona acababa de reabrir reventaba el CHECK de BD ⇒ 500. Con 0 filas
   * se relee (404 si la borraron) y se recalcula UNA vez sobre la fila
   * nueva: el doble clic concurrente responde la nota tal cual y la
   * resolución sobre una reabierta es el 400 de siempre.
   */
  async actualizar(
    notaId: string,
    cambios: CambiosSeguimiento,
    userId: string,
  ): Promise<NotaSeguimiento> {
    let actual = await this.notaViva(notaId);
    for (let intento = 0; intento < 2; intento += 1) {
      const patch = parcheSeguimiento(
        actual,
        cambios,
        userId,
        new Date().toISOString(),
      );
      if (Object.keys(patch).length === 0) {
        const [nota] = await this.conNombres([actual]);
        return nota;
      }
      const { data, error } = await this.sb
        .from('vuelo_seguimiento')
        .update(patch)
        .eq('id', notaId)
        // Una nota borrada entre la lectura y la escritura no se «revive».
        .is('deleted_at', null)
        // CAS: el parche se calculó sobre ESTE estado.
        .eq('estado', actual.estado)
        .select(COLS_SEGUIMIENTO)
        .maybeSingle();
      if (error) {
        if (esTablaInexistente(error)) throw errorSeguimientoNoDisponible();
        throw new Error(error.message);
      }
      if (data) {
        const [nota] = await this.conNombres([data]);
        return nota;
      }
      // 0 filas: la borraron (⇒ 404) o alguien la resolvió/reabrió entre la
      // lectura y la escritura ⇒ se recalcula sobre la fila VIGENTE.
      actual = await this.notaViva(notaId);
    }
    throw new ConflictException({
      message:
        'Otra persona está cambiando esta nota en este momento. Recarga la página y vuelve a intentarlo.',
      error: 'SEGUIMIENTO_CAMBIO_CONCURRENTE',
      details: { nota_id: notaId },
    });
  }

  /**
   * `DELETE /v1/flights/seguimiento/:notaId`: SOFT delete (sella
   * `deleted_at/by`). Se permite aunque esté RESUELTA; el panel CONFIRMA
   * antes (regla del cliente: toda acción destructiva confirma).
   */
  async eliminar(
    notaId: string,
    userId: string,
  ): Promise<{ ok: true; id: string; vuelo_id: string }> {
    const actual = await this.notaViva(notaId);
    const { data, error } = await this.sb
      .from('vuelo_seguimiento')
      .update({ deleted_at: new Date().toISOString(), deleted_by: userId })
      .eq('id', notaId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw errorSeguimientoNoDisponible();
      throw new Error(error.message);
    }
    if (!data) throw notaNoExiste(notaId);
    return { ok: true, id: notaId, vuelo_id: actual.vuelo_id };
  }

  /** PENDIENTES vivas de un vuelo (lo que necesitan contadores y banner). */
  private async pendientesDeVuelo(
    vueloId: string,
  ): Promise<SeguimientoRow[] | 'sin_tabla'> {
    const { data, error } = await this.sb
      .from('vuelo_seguimiento')
      .select(COLS_SEGUIMIENTO)
      .eq('vuelo_id', vueloId)
      .eq('estado', 'PENDIENTE')
      .is('deleted_at', null)
      .limit(500);
    if (error) {
      if (esTablaInexistente(error)) return 'sin_tabla';
      throw new Error(error.message);
    }
    return data ?? [];
  }

  /**
   * Contadores ADITIVOS del detalle/snapshot del vuelo. Tabla ausente ⇒ 0
   * (no existe ninguna nota); otro fallo ⇒ `null` + `warn` (nunca tumba el
   * detalle ni afirma «0 pendientes» sin haber leído).
   */
  async contadoresDeVuelo(
    vueloId: string,
  ): Promise<ContadoresSeguimientoONulos> {
    try {
      const filas = await this.pendientesDeVuelo(vueloId);
      if (filas === 'sin_tabla') return { ...CONTADORES_EN_CERO };
      return contarPendientes(filas);
    } catch (e) {
      this.logger.warn(
        `No se pudieron contar las notas de seguimiento del vuelo ${vueloId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ...CONTADORES_NULOS };
    }
  }

  /**
   * Bloque ADITIVO de la cotización: contadores + detalle de las PENDIENTE
   * que afectan la cotización (máx 20, más reciente primero) para el banner
   * ámbar del cotizador. Mismas reglas de degradación que los contadores
   * (detalle `[]` cuando no se pudo leer).
   */
  async deCotizacion(vueloId: string): Promise<SeguimientoDeCotizacion> {
    try {
      const filas = await this.pendientesDeVuelo(vueloId);
      if (filas === 'sin_tabla') {
        return { ...CONTADORES_EN_CERO, seguimiento_pendientes_detalle: [] };
      }
      const conteo = contarPendientes(filas);
      const nombres =
        conteo.seguimiento_cotizacion_pendientes > 0
          ? await fetchNombresUsuarios(
              this.sb,
              filas.map((f) => f.created_by),
            )
          : new Map<string, string>();
      return {
        ...conteo,
        seguimiento_pendientes_detalle: detallePendientesCotizacion(
          filas,
          nombres,
        ),
      };
    } catch (e) {
      this.logger.warn(
        `No se pudo leer el seguimiento de la cotización ${vueloId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ...CONTADORES_NULOS, seguimiento_pendientes_detalle: [] };
    }
  }
}

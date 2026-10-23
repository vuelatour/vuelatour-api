/**
 * COSTO REAL AFAC POR VUELO (16-oct-2026, API 0.0.89, invariante 90,
 * migración `20261016000005`). Lo escribe el visor del Balance general en
 * pantalla (celda EGRESO de cada fila «AFAC por vuelo» de «otros
 * movimientos»): `PUT` guarda el monto, `DELETE` lo QUITA (vuelve a «sin
 * capturar»: UPDATE a null, nunca un borrado físico — la bitácora
 * `afac_vuelo_bitacora` registra ALTA / CAMBIO / QUITADO con el actor).
 *
 * No crea gasto (decisión 3 del cliente): el pago al gestor se captura en
 * Gastos y se marca «Pago de AFAC». Idempotente: el mismo cuerpo no escribe
 * (`sin_cambios: true`). Última escritura gana entre dos pestañas.
 *
 * Validaciones EN ORDEN: 503 `AFAC_REAL_NO_DISPONIBLE` (sonda) → 404
 * `VUELO_NO_EXISTE` → 400 `AFAC_VUELO_SIN_AVION` → 400
 * `AFAC_VUELO_SIN_FECHA` → 400 `PERIODO_ANTES_DEL_INICIO` (ningún libro lo
 * mostraría, invariante 86) → 409 `MES_CERRADO` por el mes CONTABLE del
 * vuelo (invariante 89: un diferido a un mes abierto acepta).
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ConfiguracionService } from '../configuracion/configuracion.service';
import {
  afacRealDisponible,
  errorAfacRealNoDisponible,
} from '../../common/afac-real-disponible.util';
import {
  MENSAJE_AFAC_VUELO_SIN_AVION,
  MENSAJE_AFAC_VUELO_SIN_FECHA,
  MENSAJE_COSTO_REAL_AFAC_INVALIDO,
  validarCostoRealAfac,
} from '../../common/afac-real.util';
import { AFAC_VUELO_COLS } from '../../common/afac-real.lector';
import { cierreMesDisponible } from '../../common/cierre-mes-disponible.util';
import {
  assertMesAbierto,
  avionesDelVueloCandado,
} from '../../common/cierre-mes.lector';
import { colsVueloContable } from '../../common/filtro-periodo-contable.util';
import {
  diaContableDeVuelo,
  mesContableDeVuelo,
  type VueloFechaContable,
} from '../../common/fecha-contable.util';
import {
  inicioOficialDe,
  mensajePeriodoAntesDelInicio,
} from '../../common/inicio-oficial.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import type { PutAfacRealDto } from './dto/afac-real.dto';

/** El vuelo leído para validar la captura. */
interface VueloAfac extends VueloFechaContable {
  id: string;
  folio: number | null;
  aeronave_id: string | null;
  es_externo: boolean | null;
}

/** La fila de `afac_vuelo` (lo que se lee y devuelve). */
interface FilaAfacVuelo {
  vuelo_id: string;
  costo_real_mxn: number | string | null;
  notas: string | null;
  capturado_por: string | null;
  capturado_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Respuesta de `PUT` y `DELETE`. */
export interface AfacRealRespuesta {
  vuelo_id: string;
  folio: number | null;
  costo_real_mxn: number | null;
  notas: string | null;
  capturado_por: { id: string; nombre: string | null } | null;
  capturado_at: string | null;
  updated_at: string | null;
  mes_contable: string | null;
  sin_cambios: boolean;
}

const CODIGO_UNICO = '23505';

function numero(v: unknown): number | null {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

/** Notas normalizadas: texto recortado o null. */
function notasDe(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

@Injectable()
export class AfacRealService {
  constructor(
    private readonly supabase: SupabaseService,
    @Optional() private readonly configuracion?: ConfiguracionService,
  ) {}

  /** `PUT /v1/flights/:id/afac-real`. */
  async guardar(
    vueloId: string,
    dto: PutAfacRealDto,
    userId: string,
  ): Promise<AfacRealRespuesta> {
    const costo = validarCostoRealAfac(dto.costo_real_mxn);
    if (costo == null) {
      throw new BadRequestException({
        message: MENSAJE_COSTO_REAL_AFAC_INVALIDO,
        error: 'AFAC_COSTO_INVALIDO',
      });
    }
    const vuelo = await this.validarVuelo(vueloId);
    const sb = this.supabase.service;
    const actual = await this.leerFila(vueloId);
    const notas =
      dto.notas === undefined ? (actual?.notas ?? null) : notasDe(dto.notas);
    const costoActual = numero(actual?.costo_real_mxn);
    if (actual && costoActual === costo && (actual.notas ?? null) === notas) {
      return this.respuesta(vuelo, actual, true);
    }
    const ahora = new Date().toISOString();
    if (!actual) {
      const { data, error } = await sb
        .from('afac_vuelo')
        .insert({
          vuelo_id: vueloId,
          costo_real_mxn: costo,
          notas,
          capturado_por: userId,
          capturado_at: ahora,
          updated_by: userId,
        })
        .select(AFAC_VUELO_COLS)
        .maybeSingle();
      if (!error && data) {
        return this.respuesta(vuelo, data, false);
      }
      // Carrera: otra pestaña creó la fila entre la lectura y el INSERT ⇒
      // camino UPDATE (última escritura gana; la bitácora guarda ambas).
      if (error?.code !== CODIGO_UNICO) {
        throw new Error(
          `Costo real AFAC del vuelo #${vuelo.folio ?? '?'}: ${error?.message ?? 'sin fila'}`,
        );
      }
    }
    const previo = actual ?? (await this.leerFila(vueloId));
    const cambiaCosto = numero(previo?.costo_real_mxn) !== costo;
    const { data, error } = await sb
      .from('afac_vuelo')
      .update({
        costo_real_mxn: costo,
        notas,
        updated_by: userId,
        // Quién/cuándo puso el valor VIGENTE: solo si el MONTO cambia.
        ...(cambiaCosto ? { capturado_por: userId, capturado_at: ahora } : {}),
      })
      .eq('vuelo_id', vueloId)
      .select(AFAC_VUELO_COLS)
      .maybeSingle();
    if (error || !data) {
      throw new Error(
        `Costo real AFAC del vuelo #${vuelo.folio ?? '?'}: ${error?.message ?? 'sin fila'}`,
      );
    }
    return this.respuesta(vuelo, data, false);
  }

  /** `DELETE /v1/flights/:id/afac-real`: vuelve a «sin capturar». */
  async quitar(vueloId: string, userId: string): Promise<AfacRealRespuesta> {
    const vuelo = await this.validarVuelo(vueloId);
    const actual = await this.leerFila(vueloId);
    if (!actual || numero(actual.costo_real_mxn) == null) {
      return this.respuesta(vuelo, actual, true);
    }
    const { data, error } = await this.supabase.service
      .from('afac_vuelo')
      .update({
        costo_real_mxn: null,
        capturado_por: null,
        capturado_at: null,
        updated_by: userId,
      })
      .eq('vuelo_id', vueloId)
      .select(AFAC_VUELO_COLS)
      .maybeSingle();
    if (error || !data) {
      throw new Error(
        `Quitar el costo real AFAC del vuelo #${vuelo.folio ?? '?'}: ${error?.message ?? 'sin fila'}`,
      );
    }
    return this.respuesta(vuelo, data, false);
  }

  /** Sonda → vuelo → avión → fecha → inicio oficial → mes cerrado. */
  private async validarVuelo(vueloId: string): Promise<VueloAfac> {
    const sb = this.supabase.service;
    if (!(await afacRealDisponible(sb))) throw errorAfacRealNoDisponible();
    const contable = await cierreMesDisponible(sb);
    const { data, error } = await sb
      .from('vuelo')
      .select(
        `id, folio, fecha_vuelo, aeronave_id, es_externo${colsVueloContable(contable)}`,
      )
      .eq('id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new NotFoundException({
        message: `Vuelo ${vueloId} not found`,
        error: 'VUELO_NO_EXISTE',
        details: { vuelo_id: vueloId },
      });
    }
    const vuelo = data as unknown as VueloAfac;
    if (!vuelo.aeronave_id) {
      throw new BadRequestException({
        message: MENSAJE_AFAC_VUELO_SIN_AVION,
        error: 'AFAC_VUELO_SIN_AVION',
      });
    }
    const dia = diaContableDeVuelo(vuelo);
    if (!vuelo.fecha_vuelo || !dia) {
      throw new BadRequestException({
        message: MENSAJE_AFAC_VUELO_SIN_FECHA,
        error: 'AFAC_VUELO_SIN_FECHA',
      });
    }
    const inicio = await inicioOficialDe(this.configuracion);
    if (inicio && dia < inicio) {
      throw new BadRequestException({
        message: mensajePeriodoAntesDelInicio(inicio),
        error: 'PERIODO_ANTES_DEL_INICIO',
        details: { inicio },
      });
    }
    // CIERRE POR AVIÓN (invariante 105): el avión del vuelo (y los demás
    // participantes de un multi-avión).
    await assertMesAbierto(
      sb,
      mesContableDeVuelo(vuelo),
      'afac_real',
      await avionesDelVueloCandado(sb, vuelo),
    );
    return vuelo;
  }

  private async leerFila(vueloId: string): Promise<FilaAfacVuelo | null> {
    const { data, error } = await this.supabase.service
      .from('afac_vuelo')
      .select(AFAC_VUELO_COLS)
      .eq('vuelo_id', vueloId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  }

  private async respuesta(
    vuelo: VueloAfac,
    fila: FilaAfacVuelo | null,
    sinCambios: boolean,
  ): Promise<AfacRealRespuesta> {
    const costo = numero(fila?.costo_real_mxn);
    const por = costo != null ? (fila?.capturado_por ?? null) : null;
    const nombres = por
      ? await fetchNombresUsuarios(this.supabase.service, [por])
      : new Map<string, string>();
    return {
      vuelo_id: vuelo.id,
      folio: numero(vuelo.folio),
      costo_real_mxn: costo,
      notas: fila?.notas ?? null,
      capturado_por: por ? { id: por, nombre: nombres.get(por) ?? null } : null,
      capturado_at: costo != null ? (fila?.capturado_at ?? null) : null,
      updated_at: fila?.updated_at ?? null,
      mes_contable: mesContableDeVuelo(vuelo),
      sin_cambios: sinCambios,
    };
  }
}

import type { Rol } from '../../common/types/auth.types';
import type { CreateCobroDto } from './dto/cobros.dto';

/**
 * Token de inyección de «los cobros de un vuelo» (23-nov-2026, invariante
 * 143): lo provee `FlightsModule` como alias de `FlightsService`
 * (`useExisting`) y lo consume `CobroUtilidadesService` (módulo
 * profit-sharing).
 *
 * POR QUÉ UN TOKEN y no la clase: importar `FlightsService` desde
 * profit-sharing arrastra toda su cadena de módulos (calendar → realtime →
 * `jose`, que es ESM) a cualquier spec que cargue `ProfitSharingController`.
 * Este archivo no importa nada en tiempo de ejecución (solo tipos): quien lo
 * usa depende del CONTRATO, no del servicio.
 */
export const COBROS_DE_VUELO = 'COBROS_DE_VUELO';

/** Lo que el cobro con utilidades necesita de `FlightsService`. */
export interface CobrosDeVuelo {
  /** El vuelo (404 `VUELO_NO_EXISTE` si no existe). */
  findById(id: string): Promise<Record<string, unknown>>;
  /**
   * El alta de siempre. Con `interna.utilidades` el cobro entra junto con su
   * entrega al socio en una transacción (`cobro_utilidades_registrar`).
   */
  createCobro(
    vueloId: string,
    dto: CreateCobroDto,
    userId: string,
    rol?: Rol,
    sobre?: undefined,
    anticipo?: undefined,
    interna?: { utilidades?: { entrega: Record<string, unknown> } },
  ): Promise<Record<string, unknown>>;
}

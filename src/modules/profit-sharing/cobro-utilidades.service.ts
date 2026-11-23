import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  METODO_COBRO_UTILIDADES,
  cobroUtilidadesDisponible,
  diaCancunDe,
  entregaDeCobro,
  errorCobroUtilidadesNoDisponible,
  referenciaEntregaDeVuelo,
} from '../../common/cobro-utilidades.util';
import { normalizarTc } from '../../common/tc.util';
import {
  COBROS_DE_VUELO,
  type CobrosDeVuelo,
} from '../flights/cobros-de-vuelo.token';
import type { CreateCobroDto } from '../flights/dto/cobros.dto';
import { SupabaseService } from '../supabase/supabase.service';
import type { CobroConUtilidadesDto } from './dto/cobro-utilidades.dto';
import type { FilaCuentaSocio } from './reparto-cuenta.util';
import { RepartoPagoService, type ActorPagos } from './reparto-pago.service';
import type { PagoSocio } from './reparto-pago.util';

/** Respuesta del alta: el cobro del vuelo + su entrega + la cuenta del socio. */
export interface RespuestaCobroUtilidades {
  cobro: Record<string, unknown>;
  pago: PagoSocio;
  cuenta: FilaCuentaSocio;
  idempotente?: true;
}

/**
 * EL SOCIO PAGA SU VUELO CON SUS UTILIDADES (23-nov-2026, API 0.0.148,
 * invariante 143; modelo en `common/cobro-utilidades.util`).
 *
 * Este servicio NO calcula dinero ni tiene reglas propias: ORQUESTA las dos
 * fuentes únicas de siempre y las junta en una sola escritura atómica:
 *  1. `RepartoPagoService.prepararEntregaDeVuelo` valida la ENTREGA con los
 *     candados de «Pagos a socios» (dinero, fecha, mes abierto, socio del
 *     avión, adelanto ⇒ 409 `PAGO_EXCEDE_SALDO`) y arma su fila SIN insertar;
 *  2. `FlightsService.createCobro` valida el COBRO con los candados de
 *     siempre (mes del vuelo abierto, saldo del vuelo ⇒ 409
 *     `COBRO_EXCEDE_SALDO`, idempotencia) y, con la opción interna
 *     `utilidades`, inserta cobro y entrega JUNTOS por la función de BD.
 * Todo lo que puede rechazar va ANTES de escribir; la escritura es una sola.
 */
@Injectable()
export class CobroUtilidadesService {
  private readonly logger = new Logger(CobroUtilidadesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly pagos: RepartoPagoService,
    // `FlightsService` por su token (no por la clase): ver el token.
    @Inject(COBROS_DE_VUELO)
    private readonly flights: CobrosDeVuelo,
  ) {}

  private get sb() {
    return this.supabase.service;
  }

  /** Reloj (los specs lo fijan). */
  ahora(): Date {
    return new Date();
  }

  /** `POST /v1/profit-sharing/vuelos/:vueloId/cobro-utilidades`. */
  async registrar(
    vueloId: string,
    dto: CobroConUtilidadesDto,
    actor: ActorPagos,
  ): Promise<RespuestaCobroUtilidades> {
    if (!(await cobroUtilidadesDisponible(this.sb))) {
      throw errorCobroUtilidadesNoDisponible();
    }
    // Idempotencia PRIMERO: el reintento de un alta que sí quedó no debe
    // rebotar en ningún candado (el saldo del vuelo ya lo cuenta cobrado).
    const ya = await this.cobroPorLlave(vueloId, dto.client_request_id);
    if (ya) return this.respuestaDe(ya, dto.socio_id, true);

    const vuelo = await this.flights.findById(vueloId);
    const fechaCobro = dto.fecha_cobro ?? this.ahora();
    // El T.C. es el MISMO en las dos filas: el capturado o, sin él, el de la
    // cotización del vuelo (la entrega lo exige en las dos monedas).
    const tc =
      normalizarTc(dto.tc_usd_mxn) ?? normalizarTc(vuelo.tc_usd_mxn) ?? null;

    const entrega = await this.pagos.prepararEntregaDeVuelo(
      {
        socio_id: dto.socio_id,
        aeronave_id: dto.aeronave_id,
        monto: dto.monto,
        moneda: dto.moneda,
        tc_usd_mxn: tc,
        // El mes de utilidades del que se descuenta = el mes de esta fecha.
        fecha_pago: diaCancunDe(fechaCobro.toISOString()),
        referencia: referenciaEntregaDeVuelo(
          vuelo.folio == null ? null : Number(vuelo.folio),
        ),
        notas: dto.notas ?? null,
        aceptar_exceso: dto.aceptar_exceso === true,
        client_request_id: dto.client_request_id,
      },
      actor,
    );

    const cobroDto = {
      monto: dto.monto,
      moneda: dto.moneda,
      metodo_cobro: METODO_COBRO_UTILIDADES,
      // En pesos el cobro guarda su T.C. (así convierte `cobrosEnUsd`); en
      // dólares no hace falta, como en cualquier cobro en USD.
      ...(dto.moneda === 'MXN' && tc != null ? { tc_usd_mxn: tc } : {}),
      fecha_cobro: fechaCobro,
      ...(dto.notas ? { notas: dto.notas } : {}),
      client_request_id: dto.client_request_id,
    } as unknown as CreateCobroDto;
    const cobro = await this.flights.createCobro(
      vueloId,
      cobroDto,
      actor.userId,
      actor.rol,
      undefined,
      undefined,
      { utilidades: { entrega: entrega.fila } },
    );
    const replay = cobro.idempotente === true;
    this.logger.log(
      `Cobro con utilidades ${String(cobro.id)}: vuelo ${vueloId} (#${String(vuelo.folio)}), socio ${dto.socio_id}, avión ${dto.aeronave_id}, ${dto.monto} ${dto.moneda} (${entrega.monto_mxn} MXN), por entregar antes ${entrega.por_entregar_mxn} MXN${entrega.adelanto ? ' — ADELANTO (aceptado)' : ''}, por ${actor.userId}${replay ? ' (replay)' : ''}`,
    );
    return this.respuestaDe(cobro, dto.socio_id, replay);
  }

  /** El cobro de ESE vuelo con esa llave (replay), o null. */
  private async cobroPorLlave(
    vueloId: string,
    llave: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.sb
      .from('cobro_vuelo')
      .select('id, vuelo_id, monto, moneda, metodo_cobro, fecha_cobro')
      .eq('vuelo_id', vueloId)
      .eq('client_request_id', llave)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ?? null;
  }

  /** `{cobro, pago, cuenta}` con la cuenta del socio ya recalculada. */
  private async respuestaDe(
    cobro: Record<string, unknown>,
    socioId: string,
    replay: boolean,
  ): Promise<RespuestaCobroUtilidades> {
    const entregaId = await entregaDeCobro(this.sb, String(cobro.id));
    if (!entregaId) {
      // No debería ocurrir (el alta es atómica): la llave es de un cobro
      // normal del mismo vuelo.
      throw new Error(
        `El cobro ${String(cobro.id)} no tiene entrega al socio ligada`,
      );
    }
    const { pago, cuenta } = await this.pagos.despuesDeVuelo(
      socioId,
      entregaId,
    );
    return { cobro, pago, cuenta, ...(replay ? { idempotente: true } : {}) };
  }
}

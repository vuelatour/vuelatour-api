import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AircraftService } from '../aircraft/aircraft.service';
import { AirportsService } from '../airports/airports.service';
import { RoutesService } from '../routes/routes.service';
import {
  CalculateQuoteDto,
  MetodoPago,
  TipoTarifa,
} from './dto/calculate-quote.dto';

interface ResolvedRoute {
  origen_iata: string;
  destino_iata: string;
  millas_nauticas: number;
  es_redondo_auto: boolean;
  num_aterrizajes: number;
  ruta_id: string | null;
}

const IVA_DEFAULT = 0.16;
const CALZOS_HR_POR_ATERRIZAJE = 0.15;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

@Injectable()
export class QuotesService {
  constructor(
    private readonly aircraft: AircraftService,
    private readonly airports: AirportsService,
    private readonly routes: RoutesService,
  ) {}

  async calculate(dto: CalculateQuoteDto) {
    const aeronave = await this.aircraft.findById(dto.aeronave_id);
    if (!aeronave.activa) throw new BadRequestException('Aeronave inactiva');

    const route = await this.resolveRoute(dto);
    const matriculaPrefix = this.derivarMatriculaPrefix(aeronave.matricula);

    const nmTotal = route.es_redondo_auto
      ? Number(route.millas_nauticas) * 2
      : Number(route.millas_nauticas);

    const velocidadKts = Number(aeronave.velocidad_crucero_kts);
    if (!velocidadKts || velocidadKts <= 0) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene velocidad_crucero_kts válida`,
      );
    }
    const tiempoVueloHr = nmTotal / velocidadKts;
    const calzosHr = route.num_aterrizajes * CALZOS_HR_POR_ATERRIZAJE;
    const tiempoCobrableHr = tiempoVueloHr + calzosHr;

    // Tarifa
    const tarifaHora =
      dto.tarifa_hora_override_usd ??
      (dto.tipo_tarifa === TipoTarifa.PUBLICO
        ? Number(aeronave.tarifa_hora_pub_usd)
        : Number(aeronave.tarifa_hora_broker_usd));
    if (!tarifaHora || tarifaHora <= 0) {
      throw new BadRequestException(
        `Aeronave ${aeronave.matricula} no tiene tarifa ${dto.tipo_tarifa} configurada y no se proveyó tarifa_hora_override_usd`,
      );
    }
    const subtotal = tiempoCobrableHr * tarifaHora;

    // TUAS — solo en origen y destino (no en escalas intermedias por ahora)
    const tuasOrigen = await this.computeTuas(
      route.origen_iata,
      matriculaPrefix,
      dto.pase_abordar ?? false,
      dto.tuas_override_usd_pax,
    );
    const tuasDestino = await this.computeTuas(
      route.destino_iata,
      matriculaPrefix,
      dto.pase_abordar ?? false,
      dto.tuas_override_usd_pax,
    );
    const tuasTotal =
      (tuasOrigen.aplica ? tuasOrigen.usd_pax * dto.pasajeros : 0) +
      (tuasDestino.aplica ? tuasDestino.usd_pax * dto.pasajeros : 0);

    // IVA
    const ivaAplicaPorMetodo =
      dto.metodo_pago === MetodoPago.TRANSFERENCIA ||
      dto.metodo_pago === MetodoPago.HSBC_LINK;
    const ivaPct =
      dto.iva_pct_override !== undefined
        ? dto.iva_pct_override
        : ivaAplicaPorMetodo
          ? IVA_DEFAULT
          : 0;
    const baseIva = subtotal + tuasTotal;
    const iva = baseIva * ivaPct;
    const total = baseIva + iva;

    return {
      aeronave: {
        id: aeronave.id,
        matricula: aeronave.matricula,
        modelo: aeronave.modelo,
        pais_registro: aeronave.pais_registro,
        velocidad_crucero_kts: velocidadKts,
      },
      ruta: {
        id: route.ruta_id,
        origen_iata: route.origen_iata,
        destino_iata: route.destino_iata,
        millas_nauticas_base: Number(route.millas_nauticas),
        millas_nauticas_totales: round2(nmTotal),
        es_redondo_auto: route.es_redondo_auto,
        num_aterrizajes: route.num_aterrizajes,
      },
      tiempos: {
        vuelo_hr: round4(tiempoVueloHr),
        calzos_hr: round4(calzosHr),
        cobrable_hr: round4(tiempoCobrableHr),
      },
      tarifa: {
        tipo: dto.tipo_tarifa,
        usd_por_hora: round2(tarifaHora),
        proviene_de_override: dto.tarifa_hora_override_usd !== undefined,
      },
      tuas: {
        usd_pax_default: dto.tuas_override_usd_pax,
        pasajeros: dto.pasajeros,
        origen: tuasOrigen,
        destino: tuasDestino,
        total_usd: round2(tuasTotal),
      },
      iva: {
        aplica_por_metodo_pago: ivaAplicaPorMetodo,
        porcentaje: round4(ivaPct),
        base_usd: round2(baseIva),
        monto_usd: round2(iva),
        nota:
          dto.metodo_pago === MetodoPago.EFECTIVO
            ? 'Pago en efectivo: sin IVA (subtotal)'
            : ivaAplicaPorMetodo
              ? 'Pago facturable: IVA 16% sobre (subtotal + TUAS)'
              : `Método ${dto.metodo_pago}: sin IVA por default`,
      },
      totales: {
        subtotal_vuelo_usd: round2(subtotal),
        tuas_total_usd: round2(tuasTotal),
        iva_usd: round2(iva),
        total_usd: round2(total),
      },
      meta: {
        calculado_at: new Date().toISOString(),
        version_motor: '1.0.0',
      },
    };
  }

  private async resolveRoute(dto: CalculateQuoteDto): Promise<ResolvedRoute> {
    if (dto.ruta_id) {
      const r = await this.routes.findById(dto.ruta_id);
      if (!r.activa) throw new BadRequestException('Ruta inactiva');
      return {
        ruta_id: r.id,
        origen_iata: r.origen_iata,
        destino_iata: r.destino_iata,
        millas_nauticas: Number(r.millas_nauticas),
        es_redondo_auto: r.es_redondo_auto,
        num_aterrizajes: r.num_aterrizajes,
      };
    }
    if (!dto.origen_iata || !dto.destino_iata || dto.millas_nauticas === undefined) {
      throw new BadRequestException(
        'Provee ruta_id o (origen_iata + destino_iata + millas_nauticas)',
      );
    }
    return {
      ruta_id: null,
      origen_iata: dto.origen_iata.toUpperCase(),
      destino_iata: dto.destino_iata.toUpperCase(),
      millas_nauticas: dto.millas_nauticas,
      es_redondo_auto: dto.es_redondo_auto ?? true,
      num_aterrizajes: dto.num_aterrizajes ?? 2,
    };
  }

  private derivarMatriculaPrefix(matricula: string): 'XA' | 'XB' | 'N' {
    const m = matricula.toUpperCase();
    if (m.startsWith('XA')) return 'XA';
    if (m.startsWith('XB')) return 'XB';
    if (m.startsWith('N')) return 'N';
    throw new BadRequestException(
      `Matrícula ${matricula} no reconocida (debe empezar con XA, XB o N)`,
    );
  }

  private async computeTuas(
    iata: string,
    matriculaPrefix: 'XA' | 'XB' | 'N',
    paseAbordar: boolean,
    override?: number,
  ): Promise<{ aplica: boolean; usd_pax: number; razon: string; iata: string }> {
    try {
      const result = await this.airports.computeTuasUsdPax(
        iata,
        matriculaPrefix,
        paseAbordar,
      );
      const usdPax = override !== undefined ? override : result.usd_pax;
      return {
        iata,
        aplica: result.aplica,
        usd_pax: result.aplica ? usdPax : 0,
        razon: result.razon,
      };
    } catch (e) {
      if (e instanceof NotFoundException) {
        return {
          iata,
          aplica: override !== undefined && override > 0,
          usd_pax: override ?? 0,
          razon: `Aeropuerto ${iata} no registrado en catálogo${override !== undefined ? ' — usando override' : ' — TUAS no calculada'}`,
        };
      }
      throw e;
    }
  }
}

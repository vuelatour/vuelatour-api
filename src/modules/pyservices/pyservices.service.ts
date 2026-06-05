import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvVars } from '../../config/env.schema';

export interface RepartoSocioPayload {
  socio_nombre: string;
  porcentaje: number;
  monto_usd: number;
}

export interface RepartoAvionPayload {
  matricula: string;
  modelo: string;
  ingresos_cobrado_usd: number;
  pendiente_cobro_usd: number;
  gastos_directos_usd: number;
  gastos_indirectos_usd: number;
  permisos_usd: number;
  otros_usd: number;
  reserva_overhaul_usd: number;
  saldo_usd: number;
  reparto: RepartoSocioPayload[];
}

export interface RepartoPdfPayload {
  periodo_desde: string;
  periodo_hasta: string;
  generado: string;
  aviones: RepartoAvionPayload[];
}

/**
 * Cliente HTTP del microservicio Python (vuelatour-pyservices).
 * Autentica con el header X-Service-Token contra PYSERVICES_TOKEN.
 */
@Injectable()
export class PyservicesService {
  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async generateRepartoPdf(payload: RepartoPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reparto', payload);
  }

  private async postForBuffer(path: string, body: unknown): Promise<Buffer> {
    const baseUrl = this.config.get('PYSERVICES_URL', { infer: true });
    const token = this.config.get('PYSERVICES_TOKEN', { infer: true });
    if (!token) {
      throw new ServiceUnavailableException(
        'PYSERVICES_TOKEN no configurado: el microservicio Python no esta enlazado',
      );
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': token,
      },
      body: JSON.stringify(body),
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'error de red';
      throw new BadGatewayException(
        `No se pudo contactar a pyservices: ${msg}`,
      );
    });

    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      throw new BadGatewayException(
        `pyservices respondio ${res.status}: ${detalle.slice(0, 300)}`,
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

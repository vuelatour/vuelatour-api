import {
  BadGatewayException,
  Injectable,
  Logger,
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

export type TablaColumnaTipo = 'texto' | 'money' | 'numero' | 'entero' | 'pct';
export interface TablaColumnaPayload {
  label: string;
  tipo?: TablaColumnaTipo;
}
export interface TablaXlsxPayload {
  titulo: string;
  subtitulo?: string;
  columnas: TablaColumnaPayload[];
  filas: (string | number | null)[][];
  totales?: (string | number | null)[];
}

export interface ReporteVueloLineaPayload {
  fecha?: string | null;
  concepto?: string;
  detalle?: string | null;
  moneda?: string | null;
  monto?: number | null;
  /** Litros cargados (solo líneas de combustible; precio x litro = monto/litros). */
  litros?: number | null;
}
export interface ReporteVueloTramoPayload {
  orden: number;
  ruta: string;
  pasajeros?: number | null;
  pasajeros_nombres?: string | null;
  taco_salida?: number | null;
  taco_llegada?: number | null;
  horas?: number | null;
  es_ferry?: boolean;
}
export interface ReporteVueloPayload {
  generado: string;
  folio: string;
  cliente?: string;
  aeronave?: string | null;
  piloto?: string | null;
  copiloto?: string | null;
  tipo?: string;
  estado?: string;
  ruta?: string;
  fecha_vuelo?: string | null;
  fecha_traslado_final?: string | null;
  pasajeros?: number;
  pasajeros_nombres?: string | null;
  tarifa_tipo?: string | null;
  tarifa_hora_usd?: number | null;
  tiempo_cobrable_hr?: number | null;
  subtotal_usd?: number;
  tuas_usd?: number;
  iva_usd?: number;
  viaticos_pernocta_usd?: number;
  extras_total_usd?: number;
  ajuste_final_usd?: number;
  total_usd?: number;
  total_mxn?: number | null;
  tc_usd_mxn?: number | null;
  // Comisión del vendedor (interna): neto = total − comisión, lo de VuelaTour.
  comision_vendedor_usd?: number;
  comision_vendedor_nombre?: string | null;
  neto_vuelatour_usd?: number | null;
  metodo_cobro?: string | null;
  tramos?: ReporteVueloTramoPayload[];
  // Comparación horas cotizadas vs voladas (utilidad operativa) + motivos.
  horas_cotizadas_hr?: number | null;
  horas_voladas_hr?: number | null;
  horas_delta_hr?: number | null;
  notas_horas?: string[];
  cobros?: ReporteVueloLineaPayload[];
  total_cobrado_usd?: number;
  /** Comisiones bancarias de los cobros (USD): el banco depositó menos. */
  comision_banco_usd?: number;
  /** Total cobrado − comisiones bancarias = lo que entró a la cuenta. */
  total_cobrado_neto_usd?: number | null;
  saldo_usd?: number;
  combustible?: ReporteVueloLineaPayload[];
  gastos?: ReporteVueloLineaPayload[];
  // ===== Economía del vuelo (formato de los Excel de control del equipo:
  // "Balance VGV" / "Dinero"): venta vs costo, remanente y ganancia. =====
  /** Tacómetro global: primera salida y última llegada con lectura. */
  taco_inicio?: number | null;
  taco_fin?: number | null;
  /** Gastos del vuelo convertidos a USD (misma regla que el reparto:
   *  USD directo, MXN ÷ tc_gasto; los sin TC se excluyen y se reportan). */
  gastos_total_usd?: number;
  combustible_total_usd?: number;
  gastos_sin_tc_count?: number;
  gastos_sin_tc_mxn?: number;
  /** Venta sin IVA (total − IVA): base del % de ganancia, como en el Excel. */
  venta_sin_iva_usd?: number;
  /** Venta (total c/IVA) − gastos del vuelo. */
  remanente_usd?: number | null;
  /** Remanente − comisión vendedor − comisiones bancarias. */
  ganancia_final_usd?: number | null;
  /** Ganancia / horas cobradas (fallback: voladas), como el Excel. */
  ganancia_x_hr_usd?: number | null;
  /** Ganancia / venta sin IVA. */
  ganancia_pct?: number | null;
  notas?: string | null;
}

export interface GastoVueloSugerenciaPayload {
  gasto: {
    fecha: string | null;
    monto: number | null;
    moneda: string | null;
    categoria: string | null;
    notas: string | null;
    lugar: string | null;
    piloto_nombre: string | null;
  };
  candidatos: Array<{
    vuelo_id: string;
    folio: number | null;
    fecha_vuelo: string | null;
    matricula: string | null;
    ruta: string | null;
  }>;
}

export interface GastoVueloSugerenciaResult {
  vuelo_id_sugerido: string | null;
  confianza: number;
  razon: string;
  modelo: string;
}

export interface ArchivoZipPayload {
  nombre: string;
  contenido_b64: string;
}
export interface ZipPayload {
  archivos: ArchivoZipPayload[];
}

export interface FacturaRecibidaParsed {
  uuid_fiscal: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  tipo_comprobante: string | null;
  subtotal: number | null;
  total: number | null;
  moneda: string | null;
  fecha_emision: string | null;
  conceptos_resumen: string | null;
}

/**
 * Cliente HTTP del microservicio Python (vuelatour-pyservices).
 * Autentica con el header X-Internal-Token contra INTERNAL_SHARED_TOKEN
 * (misma configuración que el resto de clientes a pyservices).
 */
@Injectable()
export class PyservicesService {
  private readonly logger = new Logger(PyservicesService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async generateRepartoPdf(payload: RepartoPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reparto', payload);
  }

  /** Reporte mensual por avión en Excel (mismos datos del reparto). */
  async generateRepartoXlsx(payload: RepartoPdfPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reparto-xlsx', payload);
  }

  /** Export genérico de cualquier tabla a Excel. */
  async generateTablaXlsx(payload: TablaXlsxPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/tabla-xlsx', payload);
  }

  /** Ensambla archivos (base64) en un .zip. */
  async generateZip(payload: ZipPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/zip', payload);
  }

  /** Reporte consolidado de un vuelo en PDF. */
  async generateReporteVueloPdf(payload: ReporteVueloPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reporte-vuelo', payload);
  }

  /** Reporte consolidado de un vuelo en Excel. */
  async generateReporteVueloXlsx(payload: ReporteVueloPayload): Promise<Buffer> {
    return this.postForBuffer('/pdf/reporte-vuelo-xlsx', payload);
  }

  /** Parsea un CFDI recibido (XML de proveedor) y devuelve sus datos. */
  async parseFacturaRecibida(xmlB64: string): Promise<FacturaRecibidaParsed> {
    return this.postForJson<FacturaRecibidaParsed>('/facturacion/parse-recibida', {
      xml_b64: xmlB64,
    });
  }

  /** Sugerencia IA gasto→vuelo (elige entre candidatos deterministas). */
  async sugerirGastoVuelo(
    payload: GastoVueloSugerenciaPayload,
  ): Promise<GastoVueloSugerenciaResult | null> {
    try {
      return await this.postForJson<GastoVueloSugerenciaResult>(
        '/gastos/sugerir-vuelo',
        payload,
      );
    } catch (err) {
      this.logger.warn(
        `sugerirGastoVuelo falló: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async postForJson<T>(path: string, body: unknown): Promise<T> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify(body),
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'error de red';
      throw new BadGatewayException(`No se pudo contactar a pyservices: ${msg}`);
    });
    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      throw new BadGatewayException(
        `pyservices respondio ${res.status}: ${detalle.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  private async postForBuffer(path: string, body: unknown): Promise<Buffer> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
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

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
  /** Detalle de TUAS por aeropuerto CON su moneda (líneas del desglose
   *  canónico, informativas; la fila numérica tuas_usd sigue cuadrando). */
  tuas_detalle?: string[];
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

// ===== Balance por avión (réplica sistematizada del Excel "Balance N990GG") =====
// El API calcula TODO el dinero; pyservices SOLO pinta el libro (null = celda
// vacía, nunca 0 falso).

export interface BalanceAvionCobroPayload {
  fecha: string | null;
  /** Monto de la parcialidad en MXN (null = USD sin TC: no convertible). */
  monto_mxn: number | null;
  metodo?: string | null;
}

export interface BalanceAvionVueloPayload {
  folio: string;
  cliente: string | null;
  estado: string;
  es_externo: boolean;
  /** Fecha del vuelo (día Cancún, YYYY-MM-DD). */
  fecha: string | null;
  /** Fin del traslado si el vuelo es multi-día (día Cancún). */
  fecha_fin: string | null;
  ruta: string;
  // Bloque VENTA
  horas_cobradas: number;
  tarifa_usd: number | null;
  iva_hr_usd: number | null;
  total_usd: number | null;
  iva_usd: number | null;
  tc_venta: number | null;
  total_mxn: number | null;
  iva_mxn: number | null;
  subtotal_mxn: number | null;
  // Bloque TIEMPO/TACO
  tiempo_vuelo: number | null;
  taco_inicio: number | null;
  taco_fin: number | null;
  // Bloque COSTOS (MXN)
  gas_mxn: number | null;
  gas_litros: number | null;
  gas_precio_litro: number | null;
  op_mxn: number | null;
  piloto_mxn: number | null;
  otros_mxn: number | null;
  permiso_afac_mxn: number | null;
  costo_total_mxn: number;
  tc_costos: number | null;
  // Bloque INDICADORES USD e IVA
  costo_usd: number | null;
  costo_usd_siva: number | null;
  iva_pagado_usd: number | null;
  iva_pagado_mxn: number | null;
  remanente_mxn: number;
  dif_iva_mxn: number;
  comision_vendedor_mxn: number | null;
  ganancia_mxn: number;
  ganancia_usd: number | null;
  costo_hr_usd: number | null;
  costo_hr_usd_siva: number | null;
  // Bloque STATUS DE COBROS
  status_cobro: string;
  cobros: BalanceAvionCobroPayload[];
  cobrado_mxn: number;
  por_cobrar_mxn: number;
  por_cobrar_usd: number | null;
}

export interface BalanceAvionTotalesPayload {
  horas_cobradas: number;
  tiempo_vuelo: number;
  total_mxn: number;
  iva_mxn: number;
  subtotal_mxn: number;
  gas_mxn: number;
  gas_litros: number;
  op_mxn: number;
  piloto_mxn: number;
  otros_mxn: number;
  permiso_afac_mxn: number;
  costo_total_mxn: number;
  remanente_mxn: number;
  dif_iva_mxn: number;
  comision_vendedor_mxn: number;
  ganancia_mxn: number;
  ganancia_usd: number;
  cobrado_mxn: number;
  por_cobrar_mxn: number;
  por_cobrar_usd: number;
  /** Promedio simple de los TC de costos (Z) no nulos del periodo. */
  tc_promedio: number | null;
  /** Promedio de costo por hora volada (AN) SOLO sobre no nulos. */
  costo_hr_prom_usd: number | null;
  /** TUAs/extras/pernocta cobrados: informativo al pie, van a la general. */
  otros_ingresos_usd: number | null;
}

export interface BalanceAvionGastoFilaPayload {
  fecha: string | null;
  detalle: string;
  /** null = moneda extranjera sin TC (no convertible; va a pendientes). */
  monto_mxn: number | null;
  moneda_original: string | null;
  monto_original: number | null;
}

export interface BalanceAvionHojaGastosPayload {
  filas: BalanceAvionGastoFilaPayload[];
  total_mxn: number;
  /** total_mxn al TC promedio del periodo (null = sin TC en el periodo). */
  usd: number | null;
  /** usd / horas voladas del periodo. */
  usd_hr: number | null;
}

export interface BalanceAvionSocioPayload {
  nombre: string;
  porcentaje: number;
  monto_usd: number | null;
}

export interface BalanceAvionBalancePayload {
  utilidad_antes_usd: number;
  gastos_indirectos_usd: number | null;
  otros_usd: number | null;
  permisos_usd: number | null;
  utilidad_despues_usd: number | null;
  por_cobrar_usd: number;
  utilidad_cobrada_usd: number | null;
  socios: BalanceAvionSocioPayload[];
}

export interface BalanceAvionPayload {
  generado: string;
  matricula: string;
  modelo: string | null;
  periodo_desde: string;
  periodo_hasta: string;
  permiso_afac_usd_hr: number | null;
  tc_promedio: number | null;
  horas_voladas_hr: number;
  vuelos: BalanceAvionVueloPayload[];
  totales: BalanceAvionTotalesPayload;
  gastos_indirectos: BalanceAvionHojaGastosPayload;
  otros_gastos: BalanceAvionHojaGastosPayload;
  permisos: BalanceAvionHojaGastosPayload;
  balance: BalanceAvionBalancePayload;
  pendientes: string[];
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
  async generateReporteVueloXlsx(
    payload: ReporteVueloPayload,
  ): Promise<Buffer> {
    return this.postForBuffer('/pdf/reporte-vuelo-xlsx', payload);
  }

  /** Balance mensual por avión en Excel (libro de 6 hojas). */
  async generateBalanceAvionXlsx(
    payload: BalanceAvionPayload,
  ): Promise<Buffer> {
    // Libro grande (1 fila por vuelo + 3 ledgers): tope de 30s como el resto
    // de renders pesados (quotes-pdf) para no colgar el request del panel.
    return this.postForBuffer('/pdf/balance-avion-xlsx', payload, 30_000);
  }

  /** Parsea un CFDI recibido (XML de proveedor) y devuelve sus datos. */
  async parseFacturaRecibida(xmlB64: string): Promise<FacturaRecibidaParsed> {
    return this.postForJson<FacturaRecibidaParsed>(
      '/facturacion/parse-recibida',
      {
        xml_b64: xmlB64,
      },
    );
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

  /**
   * POST JSON con timeout (default 60s): sin él, un pyservices colgado dejaba
   * el request del panel esperando para siempre (sin AbortController no hay
   * tope del lado Node).
   */
  private async postForJson<T>(
    path: string,
    body: unknown,
    timeoutMs = 60_000,
  ): Promise<T> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch((e: unknown) => {
        if (controller.signal.aborted) {
          throw new BadGatewayException(
            `pyservices no respondio en ${Math.round(timeoutMs / 1000)}s (${path})`,
          );
        }
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
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST que devuelve binario (PDF/Excel/zip). Timeout default 60s. */
  private async postForBuffer(
    path: string,
    body: unknown,
    timeoutMs = 60_000,
  ): Promise<Buffer> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    const token = this.config.get('INTERNAL_SHARED_TOKEN', { infer: true });
    if (!baseUrl || !token) {
      throw new ServiceUnavailableException(
        'pyservices no configurado (PYSERVICES_BASE_URL / INTERNAL_SHARED_TOKEN)',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch((e: unknown) => {
        if (controller.signal.aborted) {
          throw new BadGatewayException(
            `pyservices no respondio en ${Math.round(timeoutMs / 1000)}s (${path})`,
          );
        }
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
    } finally {
      clearTimeout(timer);
    }
  }
}

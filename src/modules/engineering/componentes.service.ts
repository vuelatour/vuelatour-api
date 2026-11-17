import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MIGRACION_INGENIERIA_COMPONENTES,
  TABLA_COMPONENTE_AERONAVE,
} from '../../common/adjuntos-ingenieria.util';
import {
  columnaOpcional,
  esTablaInexistente,
} from '../../common/columna-opcional.util';
import { hoyCancun } from '../../common/fecha-cancun.util';
import { fetchNombresUsuarios } from '../../common/registrado-por.util';
import { AircraftService } from '../aircraft/aircraft.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  compararPorUrgencia,
  vidaDeComponente,
  type ContextoVida,
  type VidaComponente,
} from './componente-vida.util';
import type {
  CreateComponenteDto,
  ReemplazarComponenteDto,
  RetirarComponenteDto,
  UpdateComponenteDto,
} from './dto/componentes.dto';
import { leerPaginado } from './leer-paginado.util';

/**
 * COMPONENTES DEL AVIÓN CON VIDA LÍMITE (17-nov-2026, API 0.0.140, invariante
 * 135). Pedido del cliente: «se incluya en ese apartado de mantenimiento
 * también la lista de componentes del avión y su seguimiento […] saber cuánto
 * tiempo le queda a un foco, a una llanta».
 *
 * Aquí viven los datos CAPTURADOS (qué es, cuándo y a qué Hobbs se instaló,
 * cada cuánto se cambia). Lo que le QUEDA no se guarda: se calcula en cada
 * lectura con `componente-vida.util` (PURO), el Hobbs del avión —
 * `AircraftService.currentHobbs`, el MISMO número que la ficha pinta en
 * «Horas actuales»— y el día de hoy en hora Cancún. El panel solo lo pinta.
 */

/** Tope del historial de retirados que viaja en la lista. */
export const TOPE_RETIRADOS = 50;

type Fila = Record<string, unknown>;

const COMP_COLS =
  'id, aeronave_id, nombre, categoria, posicion, numero_parte, numero_serie, fabricante, fecha_instalacion, horas_aeronave_instalacion, horas_previas, limite_horas, limite_meses, fecha_vencimiento, aviso_horas, aviso_dias, notas, estado, fecha_retiro, horas_aeronave_retiro, motivo_retiro, reemplaza_a_id, created_at, updated_at, updated_by';

export interface ComponenteAeronave {
  id: string;
  aeronave_id: string;
  nombre: string;
  categoria: string | null;
  posicion: string | null;
  numero_parte: string | null;
  numero_serie: string | null;
  fabricante: string | null;
  fecha_instalacion: string | null;
  horas_aeronave_instalacion: number | null;
  horas_previas: number;
  limite_horas: number | null;
  limite_meses: number | null;
  fecha_vencimiento: string | null;
  aviso_horas: number;
  aviso_dias: number;
  notas: string | null;
  estado: 'INSTALADO' | 'RETIRADO';
  fecha_retiro: string | null;
  horas_aeronave_retiro: number | null;
  motivo_retiro: string | null;
  /** A quién sustituyó (null = no entró por reemplazo). */
  reemplaza_a_id: string | null;
  /** DERIVADO: quién lo sustituyó (null = nadie, o el sustituto se eliminó). */
  reemplazado_por_id: string | null;
  created_at: string;
  updated_at: string;
  actualizado_por_nombre: string | null;
  /** DERIVADO: lo calcula el API; el panel no lo recalcula. */
  vida: VidaComponente;
}

export interface ComponentesDeAeronave {
  /** `false` = la migración 20261117000001 todavía no está aplicada. */
  disponible: boolean;
  /** Hobbs actual del avión (null = sin lecturas de tacómetro). */
  horas_aeronave: number | null;
  /** Día de hoy en hora Cancún con el que se calculó la vida. */
  hoy: string;
  /** INSTALADOS, por urgencia y luego por nombre. */
  componentes: ComponenteAeronave[];
  /** RETIRADOS, el más reciente primero (tope 50). */
  retirados: ComponenteAeronave[];
}

const texto = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** Número finito o null (los `numeric` de PostgREST llegan como número o texto). */
const numero = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Texto capturado: recortado; vacío ⇒ null. */
const limpio = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

@Injectable()
export class ComponentesService {
  private readonly logger = new Logger(ComponentesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    // Hobbs del avión: FUENTE ÚNICA `AircraftService.currentHobbs` — el
    // MISMO número que la ficha pinta en «Horas actuales» (paginado, con la
    // herencia del avión del vuelo y sin tramos ni vuelos cancelados). En la
    // misma card el operador ve «Horas actuales» y, al lado, «faltan X h» de
    // un componente: si salieran de dos lecturas distintas, el restante
    // podría no cuadrar (regla del proyecto: sin cálculos paralelos).
    private readonly aircraft: AircraftService,
  ) {}

  // ===== Migración 20261117000001 =====
  // Sonda ÚNICA de la tabla: sin ella las lecturas responden
  // `disponible: false` y las escrituras 503 MIGRACION_PENDIENTE. Se enciende
  // sola en ≤ 10 min al aplicarla, sin reiniciar el API.

  private disponible(): Promise<boolean> {
    return columnaOpcional(
      this.supabase.service,
      TABLA_COMPONENTE_AERONAVE,
      'id',
      {
        tambienTabla: true,
        mensajeAusente: `Tabla ${TABLA_COMPONENTE_AERONAVE} no existe todavía: componentes del avión apagados hasta aplicar la migración ${MIGRACION_INGENIERIA_COMPONENTES}`,
      },
    ).disponible();
  }

  private migracionPendiente(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      message:
        'Los componentes del avión todavía no están disponibles: falta aplicar una actualización de la base de datos. Avisa a sistemas.',
      error: 'MIGRACION_PENDIENTE',
      details: { migracion: MIGRACION_INGENIERIA_COMPONENTES },
    });
  }

  private async exigirDisponible(): Promise<void> {
    if (!(await this.disponible())) throw this.migracionPendiente();
  }

  private noEncontrado(id: string): NotFoundException {
    return new NotFoundException({
      message:
        'Ese componente ya no existe o fue eliminado. Recarga la página.',
      error: 'COMPONENTE_NO_ENCONTRADO',
      details: { id },
    });
  }

  private yaRetirado(fila: Fila): ConflictException {
    return new ConflictException({
      message:
        'Ese componente ya estaba retirado. Recarga la página para ver cómo quedó.',
      error: 'COMPONENTE_YA_RETIRADO',
      details: {
        id: fila.id,
        fecha_retiro: fila.fecha_retiro ?? null,
      },
    });
  }

  /** Un rechazo de los candados de la tabla es un 400 legible, nunca 500. */
  private errorDeEscritura(error: {
    code?: string | null;
    message: string;
  }): Error {
    if (esTablaInexistente(error)) return this.migracionPendiente();
    if (error.code === '23514') {
      return new BadRequestException({
        message:
          'Alguno de los datos del componente no es válido (revisa el nombre, los límites y las horas).',
        error: 'COMPONENTE_INVALIDO',
        details: { tecnico: error.message },
      });
    }
    if (error.code === '23503') {
      return new NotFoundException({
        message:
          'No se encontró el avión de ese componente. Recarga la página.',
        error: 'AERONAVE_NO_ENCONTRADA',
        details: { tecnico: error.message },
      });
    }
    return new Error(error.message);
  }

  /**
   * Hobbs del avión (el de la ficha). `currentHobbs` devuelve 0 cuando el
   * avión no tiene NINGUNA lectura de tacómetro: eso es «no se sabe», no
   * «cero horas» (un 0 daría horas en servicio falsas). Es también el Hobbs
   * por omisión al retirar o reemplazar sin `horas_aeronave`.
   */
  private async hobbs(aeronaveId: string): Promise<number | null> {
    const h = await this.aircraft.currentHobbs(aeronaveId);
    return Number.isFinite(h) && h > 0 ? h : null;
  }

  private async contexto(aeronaveId: string): Promise<ContextoVida> {
    return { hoy: hoyCancun(), horasAeronave: await this.hobbs(aeronaveId) };
  }

  private aRespuesta(
    f: Fila,
    ctx: ContextoVida,
    nombres: Map<string, string>,
    reemplazadoPor: Map<string, string>,
  ): ComponenteAeronave {
    const id = f.id as string;
    const actualizadoPor = texto(f.updated_by);
    return {
      id,
      aeronave_id: f.aeronave_id as string,
      nombre: texto(f.nombre) ?? '',
      categoria: texto(f.categoria),
      posicion: texto(f.posicion),
      numero_parte: texto(f.numero_parte),
      numero_serie: texto(f.numero_serie),
      fabricante: texto(f.fabricante),
      fecha_instalacion: texto(f.fecha_instalacion),
      horas_aeronave_instalacion: numero(f.horas_aeronave_instalacion),
      horas_previas: numero(f.horas_previas) ?? 0,
      limite_horas: numero(f.limite_horas),
      limite_meses: numero(f.limite_meses),
      fecha_vencimiento: texto(f.fecha_vencimiento),
      aviso_horas: numero(f.aviso_horas) ?? 0,
      aviso_dias: numero(f.aviso_dias) ?? 0,
      notas: texto(f.notas),
      estado: f.estado === 'RETIRADO' ? 'RETIRADO' : 'INSTALADO',
      fecha_retiro: texto(f.fecha_retiro),
      horas_aeronave_retiro: numero(f.horas_aeronave_retiro),
      motivo_retiro: texto(f.motivo_retiro),
      reemplaza_a_id: texto(f.reemplaza_a_id),
      reemplazado_por_id: reemplazadoPor.get(id) ?? null,
      created_at: f.created_at as string,
      updated_at: f.updated_at as string,
      actualizado_por_nombre: actualizadoPor
        ? (nombres.get(actualizadoPor) ?? null)
        : null,
      vida: vidaDeComponente(f, ctx),
    };
  }

  /** UNA fila viva (no eliminada) o 404. */
  private async leer(id: string): Promise<Fila> {
    const { data, error } = await this.supabase.service
      .from(TABLA_COMPONENTE_AERONAVE)
      .select(COMP_COLS)
      .eq('id', id)
      .is('eliminado_at', null)
      .maybeSingle();
    if (error) {
      if (esTablaInexistente(error)) throw this.migracionPendiente();
      throw new Error(error.message);
    }
    if (!data) throw this.noEncontrado(id);
    return data;
  }

  /** Respuesta de UNA fila (con su Hobbs, su nombre y quién lo sustituyó). */
  private async respuestaDe(
    f: Fila,
    reemplazadoPor = new Map<string, string>(),
  ): Promise<ComponenteAeronave> {
    const [ctx, nombres] = await Promise.all([
      this.contexto(f.aeronave_id as string),
      fetchNombresUsuarios(this.supabase.service, [texto(f.updated_by)]),
    ]);
    return this.aRespuesta(f, ctx, nombres, reemplazadoPor);
  }

  /** Componentes del avión con su vida calculada. */
  async listar(aeronaveId: string): Promise<ComponentesDeAeronave> {
    const hoy = hoyCancun();
    const sinMigracion: ComponentesDeAeronave = {
      disponible: false,
      horas_aeronave: null,
      hoy,
      componentes: [],
      retirados: [],
    };
    if (!(await this.disponible())) return sinMigracion;
    const sb = this.supabase.service;
    const [instalados, retirados, reemplazos, horasAeronave] =
      await Promise.all([
        leerPaginado<Fila>((desde, hasta) =>
          sb
            .from(TABLA_COMPONENTE_AERONAVE)
            .select(COMP_COLS)
            .eq('aeronave_id', aeronaveId)
            .eq('estado', 'INSTALADO')
            .is('eliminado_at', null)
            .order('id', { ascending: true })
            .range(desde, hasta),
        ),
        sb
          .from(TABLA_COMPONENTE_AERONAVE)
          .select(COMP_COLS)
          .eq('aeronave_id', aeronaveId)
          .eq('estado', 'RETIRADO')
          .is('eliminado_at', null)
          .order('fecha_retiro', { ascending: false, nullsFirst: false })
          .order('updated_at', { ascending: false })
          .limit(TOPE_RETIRADOS),
        // Quién sustituyó a quién (solo sustitutos vivos).
        leerPaginado<Fila>((desde, hasta) =>
          sb
            .from(TABLA_COMPONENTE_AERONAVE)
            .select('id, reemplaza_a_id')
            .eq('aeronave_id', aeronaveId)
            .is('eliminado_at', null)
            .not('reemplaza_a_id', 'is', null)
            .order('id', { ascending: true })
            .range(desde, hasta),
        ),
        this.hobbs(aeronaveId),
      ]);
    for (const r of [instalados, retirados, reemplazos]) {
      if (r.error) {
        if (esTablaInexistente(r.error)) return sinMigracion;
        throw new Error(r.error.message);
      }
    }
    const filasRetiradas = (retirados.data ?? []) as unknown as Fila[];
    const reemplazadoPor = new Map<string, string>();
    for (const r of reemplazos.filas) {
      const viejo = texto(r.reemplaza_a_id);
      const nuevo = texto(r.id);
      if (viejo && nuevo) reemplazadoPor.set(viejo, nuevo);
    }
    const nombres = await fetchNombresUsuarios(
      sb,
      [...instalados.filas, ...filasRetiradas].map((f) => texto(f.updated_by)),
    );
    const ctx: ContextoVida = { hoy, horasAeronave };
    return {
      disponible: true,
      horas_aeronave: horasAeronave,
      hoy,
      componentes: instalados.filas
        .map((f) => this.aRespuesta(f, ctx, nombres, reemplazadoPor))
        .sort(compararPorUrgencia),
      retirados: filasRetiradas.map((f) =>
        this.aRespuesta(f, ctx, nombres, reemplazadoPor),
      ),
    };
  }

  async crear(
    aeronaveId: string,
    dto: CreateComponenteDto,
    userId: string,
  ): Promise<ComponenteAeronave> {
    await this.exigirDisponible();
    const sb = this.supabase.service;
    const { data: avion, error: errAvion } = await sb
      .from('aeronave')
      .select('id')
      .eq('id', aeronaveId)
      .maybeSingle();
    if (errAvion) throw new Error(errAvion.message);
    if (!avion) throw new NotFoundException(`Aeronave ${aeronaveId} not found`);
    const { data, error } = await sb
      .from(TABLA_COMPONENTE_AERONAVE)
      .insert({
        aeronave_id: aeronaveId,
        nombre: dto.nombre.trim(),
        categoria: limpio(dto.categoria),
        posicion: limpio(dto.posicion),
        numero_parte: limpio(dto.numero_parte),
        numero_serie: limpio(dto.numero_serie),
        fabricante: limpio(dto.fabricante),
        fecha_instalacion: dto.fecha_instalacion ?? null,
        horas_aeronave_instalacion: dto.horas_aeronave_instalacion ?? null,
        horas_previas: dto.horas_previas ?? 0,
        limite_horas: dto.limite_horas ?? null,
        limite_meses: dto.limite_meses ?? null,
        fecha_vencimiento: dto.fecha_vencimiento ?? null,
        // Sin valor ⇒ el default de la tabla (10 h / 30 días).
        ...(dto.aviso_horas != null ? { aviso_horas: dto.aviso_horas } : {}),
        ...(dto.aviso_dias != null ? { aviso_dias: dto.aviso_dias } : {}),
        notas: limpio(dto.notas),
        estado: 'INSTALADO',
        created_by: userId,
        updated_by: userId,
      })
      .select(COMP_COLS)
      .maybeSingle();
    if (error) throw this.errorDeEscritura(error);
    if (!data) throw new Error('El componente no se pudo guardar');
    return this.respuestaDe(data);
  }

  /**
   * Edita los datos capturados. `null` EXPLÍCITO limpia un opcional; lo que
   * no viaja no se toca. No cambia `estado` (para eso: reemplazar / retirar).
   */
  async editar(
    id: string,
    dto: UpdateComponenteDto,
    userId: string,
  ): Promise<ComponenteAeronave> {
    await this.exigirDisponible();
    const actual = await this.leer(id);
    const patch: Fila = {};
    if (dto.nombre !== undefined) patch.nombre = dto.nombre.trim();
    if (dto.categoria !== undefined) patch.categoria = limpio(dto.categoria);
    if (dto.posicion !== undefined) patch.posicion = limpio(dto.posicion);
    if (dto.numero_parte !== undefined) {
      patch.numero_parte = limpio(dto.numero_parte);
    }
    if (dto.numero_serie !== undefined) {
      patch.numero_serie = limpio(dto.numero_serie);
    }
    if (dto.fabricante !== undefined) patch.fabricante = limpio(dto.fabricante);
    if (dto.fecha_instalacion !== undefined) {
      patch.fecha_instalacion = dto.fecha_instalacion;
    }
    if (dto.horas_aeronave_instalacion !== undefined) {
      patch.horas_aeronave_instalacion = dto.horas_aeronave_instalacion;
    }
    if (dto.horas_previas !== undefined)
      patch.horas_previas = dto.horas_previas;
    if (dto.limite_horas !== undefined) patch.limite_horas = dto.limite_horas;
    if (dto.limite_meses !== undefined) patch.limite_meses = dto.limite_meses;
    if (dto.fecha_vencimiento !== undefined) {
      patch.fecha_vencimiento = dto.fecha_vencimiento;
    }
    if (dto.aviso_horas !== undefined) patch.aviso_horas = dto.aviso_horas;
    if (dto.aviso_dias !== undefined) patch.aviso_dias = dto.aviso_dias;
    if (dto.notas !== undefined) patch.notas = limpio(dto.notas);
    if (Object.keys(patch).length === 0) return this.respuestaDe(actual);

    // Sin disparador en la tabla: el sello lo pone el API.
    patch.updated_at = new Date().toISOString();
    patch.updated_by = userId;
    const { data, error } = await this.supabase.service
      .from(TABLA_COMPONENTE_AERONAVE)
      .update(patch)
      .eq('id', id)
      .is('eliminado_at', null)
      .select(COMP_COLS)
      .maybeSingle();
    if (error) throw this.errorDeEscritura(error);
    if (!data) throw this.noEncontrado(id);
    return this.respuestaDe(data);
  }

  /** La fecha del retiro no puede ser anterior a la de instalación. */
  private validarFechaDeRetiro(actual: Fila, fecha: string): void {
    const instalado = texto(actual.fecha_instalacion);
    if (instalado && fecha < instalado.slice(0, 10)) {
      throw new BadRequestException({
        message: `La fecha no puede ser anterior a la de instalación del componente (${instalado.slice(0, 10)}).`,
        error: 'FECHA_ANTERIOR_A_INSTALACION',
        details: { fecha, fecha_instalacion: instalado.slice(0, 10) },
      });
    }
  }

  /**
   * Pasa el componente a RETIRADO con su fecha, Hobbs y motivo. La guarda
   * `estado = INSTALADO` va EN el UPDATE: dos retiros simultáneos no se
   * pisan (el segundo no encuentra fila ⇒ `null`).
   */
  private async marcarRetirado(
    id: string,
    datos: { fecha: string; horas: number | null; motivo: string | null },
    userId: string,
  ): Promise<{ fila: Fila | null; error: { message: string } | null }> {
    const { data, error } = await this.supabase.service
      .from(TABLA_COMPONENTE_AERONAVE)
      .update({
        estado: 'RETIRADO',
        fecha_retiro: datos.fecha,
        horas_aeronave_retiro: datos.horas,
        motivo_retiro: datos.motivo,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      })
      .eq('id', id)
      .eq('estado', 'INSTALADO')
      .is('eliminado_at', null)
      .select(COMP_COLS)
      .maybeSingle();
    return { fila: data ?? null, error: error ?? null };
  }

  /** Retiro SIN sustituto. */
  async retirar(
    id: string,
    dto: RetirarComponenteDto,
    userId: string,
  ): Promise<ComponenteAeronave> {
    await this.exigirDisponible();
    const actual = await this.leer(id);
    if (actual.estado !== 'INSTALADO') throw this.yaRetirado(actual);
    this.validarFechaDeRetiro(actual, dto.fecha);
    const horas =
      dto.horas_aeronave ?? (await this.hobbs(actual.aeronave_id as string));
    const { fila, error } = await this.marcarRetirado(
      id,
      { fecha: dto.fecha, horas, motivo: limpio(dto.motivo) },
      userId,
    );
    if (error) throw this.errorDeEscritura(error);
    if (!fila) throw this.yaRetirado(actual);
    return this.respuestaDe(fila);
  }

  /**
   * CAMBIO de componente: el viejo pasa a RETIRADO y entra uno nuevo en su
   * lugar, con el mismo nombre, categoría, posición y avisos.
   *
   * LÍMITES de `nuevo` (precisión del contrato con el panel, que los manda
   * SIEMPRE): número = ese límite; `null` EXPLÍCITO = la pieza nueva NO
   * tiene ese límite (no hereda); campo AUSENTE (`undefined`) = hereda el
   * del que sale. Por eso aquí se compara `!== undefined`, nunca `??`.
   * P/N, S/N, fabricante, notas y la fecha EXACTA de vencimiento son de la
   * PIEZA: ausentes o en null quedan vacíos, jamás se heredan.
   *
   * Orden: primero se inserta el nuevo y luego se retira el viejo; si lo
   * segundo falla, el nuevo se da de baja y se responde el error: nunca
   * quedan dos instalados por un cambio a medias.
   */
  async reemplazar(
    id: string,
    dto: ReemplazarComponenteDto,
    userId: string,
  ): Promise<{ retirado: ComponenteAeronave; nuevo: ComponenteAeronave }> {
    await this.exigirDisponible();
    const sb = this.supabase.service;
    const viejo = await this.leer(id);
    if (viejo.estado !== 'INSTALADO') throw this.yaRetirado(viejo);
    this.validarFechaDeRetiro(viejo, dto.fecha);
    const aeronaveId = viejo.aeronave_id as string;
    const horasAeronave = await this.hobbs(aeronaveId);
    const horas = dto.horas_aeronave ?? horasAeronave;
    const n = dto.nuevo ?? {};

    const { data: creado, error: errAlta } = await sb
      .from(TABLA_COMPONENTE_AERONAVE)
      .insert({
        aeronave_id: aeronaveId,
        nombre: viejo.nombre,
        categoria: viejo.categoria ?? null,
        posicion: viejo.posicion ?? null,
        numero_parte: limpio(n.numero_parte),
        numero_serie: limpio(n.numero_serie),
        fabricante: limpio(n.fabricante),
        fecha_instalacion: dto.fecha,
        horas_aeronave_instalacion: horas,
        horas_previas: n.horas_previas ?? 0,
        limite_horas:
          n.limite_horas !== undefined
            ? n.limite_horas
            : (viejo.limite_horas ?? null),
        limite_meses:
          n.limite_meses !== undefined
            ? n.limite_meses
            : (viejo.limite_meses ?? null),
        fecha_vencimiento: n.fecha_vencimiento ?? null,
        aviso_horas: viejo.aviso_horas,
        aviso_dias: viejo.aviso_dias,
        notas: limpio(n.notas),
        estado: 'INSTALADO',
        reemplaza_a_id: id,
        created_by: userId,
        updated_by: userId,
      })
      .select(COMP_COLS)
      .maybeSingle();
    if (errAlta) throw this.errorDeEscritura(errAlta);
    if (!creado) throw new Error('El componente nuevo no se pudo guardar');
    const nuevo = creado as Fila;

    const { fila: retirado, error: errRetiro } = await this.marcarRetirado(
      id,
      { fecha: dto.fecha, horas, motivo: limpio(dto.motivo) },
      userId,
    );
    if (errRetiro || !retirado) {
      // Cambio a medias: el nuevo se da de baja para no dejar dos instalados.
      const { error: errBaja } = await sb
        .from(TABLA_COMPONENTE_AERONAVE)
        .update({
          eliminado_at: new Date().toISOString(),
          eliminado_por: userId,
          updated_at: new Date().toISOString(),
          updated_by: userId,
        })
        .eq('id', nuevo.id);
      if (errBaja) {
        this.logger.error(
          `Reemplazo a medias del componente ${id}: el nuevo ${String(nuevo.id)} quedó INSTALADO y no se pudo dar de baja (${errBaja.message}). Revisarlo a mano.`,
        );
      }
      if (errRetiro) throw this.errorDeEscritura(errRetiro);
      throw this.yaRetirado(viejo);
    }

    const nombres = await fetchNombresUsuarios(sb, [userId]);
    const ctx: ContextoVida = { hoy: hoyCancun(), horasAeronave };
    const reemplazadoPor = new Map<string, string>([[id, nuevo.id as string]]);
    return {
      retirado: this.aRespuesta(retirado, ctx, nombres, reemplazadoPor),
      nuevo: this.aRespuesta(nuevo, ctx, nombres, reemplazadoPor),
    };
  }

  /** Baja con sello (captura por error): la fila se conserva. */
  async eliminar(id: string, userId: string): Promise<{ ok: true }> {
    await this.exigirDisponible();
    const ahora = new Date().toISOString();
    const { data, error } = await this.supabase.service
      .from(TABLA_COMPONENTE_AERONAVE)
      .update({
        eliminado_at: ahora,
        eliminado_por: userId,
        updated_at: ahora,
        updated_by: userId,
      })
      .eq('id', id)
      .is('eliminado_at', null)
      .select('id')
      .maybeSingle();
    if (error) throw this.errorDeEscritura(error);
    if (!data) throw this.noEncontrado(id);
    return { ok: true };
  }
}

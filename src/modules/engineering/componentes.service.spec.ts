// AircraftService arrastra medio API (balance, inventario, pyservices): aquí
// solo hace falta su `currentHobbs`, que se da con un doble.
jest.mock('../aircraft/aircraft.service', () => ({
  AircraftService: class {},
}));

import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AircraftService } from '../aircraft/aircraft.service';
import { ComponentesService, TOPE_RETIRADOS } from './componentes.service';
import type { NuevoComponenteReemplazoDto } from './dto/componentes.dto';
import {
  armarFalso,
  tieneOp,
  uuid,
  type Fila,
  type OpcionesFalso,
} from './ingenieria.fixture-spec';

/**
 * COMPONENTES DEL AVIÓN CON VIDA LÍMITE (17-nov-2026, API 0.0.140, invariante
 * 135). Pedido del cliente: «la lista de componentes del avión y su
 * seguimiento […] saber cuánto tiempo le queda a un foco, a una llanta».
 *
 * Qué se congela aquí (el cálculo de la vida tiene su propio spec):
 *  - la lista: instalados por URGENCIA y nombre, retirados al final (tope 50),
 *    eliminados y otros aviones fuera, quién sustituyó a quién;
 *  - el Hobbs es `AircraftService.currentHobbs`, el MISMO número que la
 *    ficha pinta en «Horas actuales» (0 = no se sabe, jamás «cero horas»);
 *  - en un reemplazo, un null EXPLÍCITO en `nuevo` no hereda y un campo
 *    AUSENTE sí;
 *  - alta, edición con null explícito, retiro, reemplazo (también el cambio a
 *    medias) y baja con sello;
 *  - sin la migración: lecturas `disponible:false`, escrituras 503.
 */
const N990GG = uuid(1);
const XA_VGV = uuid(2);
const DIEGO = uuid(101);
const LUIS = uuid(102);
const T = 'componente_aeronave';

/** Martes 17-nov-2026, 13:00 en Cancún. */
const AHORA = new Date('2026-11-17T18:00:00Z');
const HOBBS = 5599.4;

function comp(n: number, extra: Fila): Fila {
  return {
    id: uuid(n),
    aeronave_id: N990GG,
    nombre: `Componente ${n}`,
    categoria: null,
    posicion: null,
    numero_parte: null,
    numero_serie: null,
    fabricante: null,
    fecha_instalacion: '2026-09-01',
    horas_aeronave_instalacion: 5500,
    horas_previas: 0,
    limite_horas: null,
    limite_meses: null,
    fecha_vencimiento: null,
    aviso_horas: 10,
    aviso_dias: 30,
    notas: null,
    estado: 'INSTALADO',
    fecha_retiro: null,
    horas_aeronave_retiro: null,
    motivo_retiro: null,
    reemplaza_a_id: null,
    created_at: '2026-09-01T15:00:00.000Z',
    updated_at: '2026-09-01T15:00:00.000Z',
    created_by: DIEGO,
    updated_by: DIEGO,
    eliminado_at: null,
    eliminado_por: null,
    ...extra,
  };
}

const USUARIOS: Fila[] = [
  { id: DIEGO, nombre: 'Diego Ramírez' },
  { id: LUIS, nombre: 'Luis' },
];
const AVIONES: Fila[] = [
  { id: N990GG, matricula: 'N990GG' },
  { id: XA_VGV, matricula: 'XA-VGV' },
];

function armar(filas: Fila[], opciones: Partial<OpcionesFalso> = {}) {
  const falso = armarFalso({
    tablas: { [T]: filas, usuario: USUARIOS, aeronave: AVIONES },
    ...opciones,
  });
  const currentHobbs = jest.fn().mockResolvedValue(HOBBS);
  const service = new ComponentesService(falso.supabase, {
    currentHobbs,
  } as unknown as AircraftService);
  return { service, falso, currentHobbs };
}

describe('ComponentesService (invariante 135)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  describe('listar — GET aircraft/:id/components', () => {
    // Uno de cada estado, capturados en desorden.
    const SIN_LIMITE = comp(11, { nombre: 'Extintor' });
    const VIGENTE = comp(12, { nombre: 'Batería ELT', limite_meses: 24 });
    const SIN_DATOS = comp(13, {
      nombre: 'Llanta de nariz',
      limite_horas: 300,
      horas_aeronave_instalacion: null,
    });
    const POR_VENCER = comp(14, {
      nombre: 'Foco de taxi',
      limite_horas: 105, // lleva 99.4 ⇒ le quedan 5.6
    });
    const VENCIDO = comp(15, {
      nombre: 'Llanta principal izquierda',
      fecha_vencimiento: '2026-11-10',
    });
    const VIGENTE_2 = comp(16, { nombre: 'alternador', limite_horas: 2000 });

    it('instalados por URGENCIA y luego por nombre; cada uno con su vida', async () => {
      const { service } = armar([
        SIN_LIMITE,
        VIGENTE,
        SIN_DATOS,
        POR_VENCER,
        VENCIDO,
        VIGENTE_2,
      ]);
      const res = await service.listar(N990GG);
      expect(res.disponible).toBe(true);
      expect(res.horas_aeronave).toBe(HOBBS);
      expect(res.hoy).toBe('2026-11-17');
      expect(res.componentes.map((c) => [c.nombre, c.vida.estado])).toEqual([
        ['Llanta principal izquierda', 'VENCIDO'],
        ['Foco de taxi', 'POR_VENCER'],
        ['Llanta de nariz', 'SIN_DATOS'],
        ['alternador', 'VIGENTE'],
        ['Batería ELT', 'VIGENTE'],
        ['Extintor', 'SIN_LIMITE'],
      ]);
      expect(res.retirados).toEqual([]);
      const foco = res.componentes[1];
      expect(foco.vida).toMatchObject({
        horas_en_servicio: 99.4,
        horas_restantes: 5.6,
        por: 'HORAS',
      });
      expect(res.componentes[0].vida).toMatchObject({
        vence_el: '2026-11-10',
        dias_restantes: -7,
        por: 'FECHA',
      });
      expect(res.componentes[2].vida.faltantes).toEqual([
        'horas_aeronave_instalacion',
      ]);
      expect(foco.actualizado_por_nombre).toBe('Diego Ramírez');
    });

    it('los numeric que llegan como TEXTO salen como número', async () => {
      const { service } = armar([
        comp(11, {
          horas_aeronave_instalacion: '5500.00',
          horas_previas: '12.25',
          limite_horas: '500.00',
          aviso_horas: '10.00',
        }),
      ]);
      const [c] = (await service.listar(N990GG)).componentes;
      expect(c).toMatchObject({
        horas_aeronave_instalacion: 5500,
        horas_previas: 12.25,
        limite_horas: 500,
        aviso_horas: 10,
        aviso_dias: 30,
      });
      expect(c.vida.horas_restantes).toBe(388.35);
    });

    it('eliminados y componentes de OTRO avión no salen', async () => {
      const { service } = armar([
        comp(11, { nombre: 'Vivo' }),
        comp(12, { nombre: 'Eliminado', eliminado_at: '2026-11-01T00:00:00Z' }),
        comp(13, { nombre: 'De otro avión', aeronave_id: XA_VGV }),
      ]);
      const res = await service.listar(N990GG);
      expect(res.componentes.map((c) => c.nombre)).toEqual(['Vivo']);
    });

    it('retirados: el más reciente primero, con lo que estuvieron en servicio y quién los sustituyó', async () => {
      const viejo = comp(21, {
        nombre: 'Llanta principal izquierda',
        estado: 'RETIRADO',
        fecha_retiro: '2026-10-15',
        horas_aeronave_retiro: 5560.5,
        motivo_retiro: 'Desgaste',
      });
      const masViejo = comp(22, {
        nombre: 'Foco de aterrizaje',
        estado: 'RETIRADO',
        fecha_retiro: '2026-09-20',
        horas_aeronave_retiro: 5520,
      });
      const sustituto = comp(23, {
        nombre: 'Llanta principal izquierda',
        fecha_instalacion: '2026-10-15',
        horas_aeronave_instalacion: 5560.5,
        reemplaza_a_id: viejo.id,
      });
      const { service } = armar([masViejo, viejo, sustituto]);
      const res = await service.listar(N990GG);
      expect(res.componentes.map((c) => c.id)).toEqual([sustituto.id]);
      expect(res.componentes[0]).toMatchObject({
        reemplaza_a_id: viejo.id,
        reemplazado_por_id: null,
      });
      expect(res.retirados.map((c) => c.id)).toEqual([viejo.id, masViejo.id]);
      expect(res.retirados[0]).toMatchObject({
        estado: 'RETIRADO',
        motivo_retiro: 'Desgaste',
        reemplazado_por_id: sustituto.id,
      });
      // Congelado al retiro: 5560.5 − 5500 (no el Hobbs de hoy).
      expect(res.retirados[0].vida).toMatchObject({
        horas_en_servicio: 60.5,
        dias_en_servicio: 44,
        estado: 'SIN_LIMITE',
      });
      expect(res.retirados[1].reemplazado_por_id).toBeNull();
    });

    it('un sustituto ELIMINADO ya no cuenta como «quién lo sustituyó»', async () => {
      const viejo = comp(21, {
        estado: 'RETIRADO',
        fecha_retiro: '2026-10-15',
      });
      const sustituto = comp(23, {
        reemplaza_a_id: viejo.id,
        eliminado_at: '2026-10-16T00:00:00Z',
      });
      const { service } = armar([viejo, sustituto]);
      const res = await service.listar(N990GG);
      expect(res.retirados[0].reemplazado_por_id).toBeNull();
    });

    it(`el historial de retirados viaja topado a ${TOPE_RETIRADOS}`, async () => {
      const muchos = Array.from({ length: TOPE_RETIRADOS + 7 }, (_, i) =>
        comp(200 + i, {
          estado: 'RETIRADO',
          fecha_retiro: `2026-0${1 + (i % 9)}-1${i % 9}`,
        }),
      );
      const { service } = armar(muchos);
      const res = await service.listar(N990GG);
      expect(res.retirados).toHaveLength(TOPE_RETIRADOS);
      const fechas = res.retirados.map((c) => c.fecha_retiro as string);
      expect(fechas).toEqual([...fechas].sort().reverse());
    });

    it('avión SIN lecturas de tacómetro (Hobbs 0) ⇒ horas_aeronave null y lo dice, jamás «0 horas»', async () => {
      const { service, currentHobbs } = armar([
        comp(11, { limite_horas: 500 }),
      ]);
      currentHobbs.mockResolvedValue(0);
      const res = await service.listar(N990GG);
      expect(res.horas_aeronave).toBeNull();
      expect(res.componentes[0].vida).toMatchObject({
        horas_en_servicio: null,
        horas_restantes: null,
        estado: 'SIN_DATOS',
        faltantes: ['horas_aeronave'],
      });
    });

    it('el Hobbs sale de AircraftService.currentHobbs — el MISMO de «Horas actuales» de la ficha (una sola fuente)', async () => {
      const { service, currentHobbs } = armar([comp(11, {})]);
      const res = await service.listar(N990GG);
      expect(currentHobbs).toHaveBeenCalledTimes(1);
      expect(currentHobbs).toHaveBeenCalledWith(N990GG);
      // Lo que devuelve la ficha es lo que viaja y con lo que se calcula.
      expect(res.horas_aeronave).toBe(HOBBS);
      expect(res.componentes[0].vida.horas_en_servicio).toBe(99.4);
    });

    it('si la lectura del Hobbs falla, la lista FALLA (no se disfraza de «sin datos»)', async () => {
      const { service, currentHobbs } = armar([comp(11, {})]);
      currentHobbs.mockRejectedValue(new Error('escala caída'));
      await expect(service.listar(N990GG)).rejects.toThrow('escala caída');
    });
  });

  describe('crear — POST aircraft/:id/components', () => {
    it('guarda lo capturado (recortado; vacío ⇒ null), sella quién y responde con su vida', async () => {
      const { service, falso } = armar([]);
      const res = await service.crear(
        N990GG,
        {
          nombre: '  Llanta principal izquierda ',
          categoria: 'Tren de aterrizaje',
          posicion: '   ',
          numero_serie: ' SN-123 ',
          fecha_instalacion: '2026-11-01',
          horas_aeronave_instalacion: 5590,
          limite_horas: 500,
          limite_meses: 24,
        },
        DIEGO,
      );
      const guardado = falso.cuerpo(T, 'insert');
      expect(guardado).toMatchObject({
        aeronave_id: N990GG,
        nombre: 'Llanta principal izquierda',
        categoria: 'Tren de aterrizaje',
        posicion: null,
        numero_parte: null,
        numero_serie: 'SN-123',
        fecha_instalacion: '2026-11-01',
        horas_aeronave_instalacion: 5590,
        horas_previas: 0,
        limite_horas: 500,
        limite_meses: 24,
        fecha_vencimiento: null,
        estado: 'INSTALADO',
        created_by: DIEGO,
        updated_by: DIEGO,
      });
      // Sin avisos en el DTO ⇒ no viajan: manda el default de la tabla.
      expect(guardado).not.toHaveProperty('aviso_horas');
      expect(guardado).not.toHaveProperty('aviso_dias');
      expect(res).toMatchObject({
        nombre: 'Llanta principal izquierda',
        estado: 'INSTALADO',
        aviso_horas: 10,
        aviso_dias: 30,
        reemplaza_a_id: null,
        reemplazado_por_id: null,
        actualizado_por_nombre: 'Diego Ramírez',
      });
      expect(res.vida).toMatchObject({
        horas_en_servicio: 9.4,
        horas_restantes: 490.6,
        vence_el: '2028-11-01',
        estado: 'VIGENTE',
      });
    });

    it('sin límites ⇒ se cambia «a condición» (SIN_LIMITE)', async () => {
      const { service } = armar([]);
      const res = await service.crear(N990GG, { nombre: 'Extintor' }, DIEGO);
      expect(res.vida.estado).toBe('SIN_LIMITE');
      expect(res.vida.horas_en_servicio).toBeNull();
    });

    it('avión que no existe ⇒ 404 y nada escrito', async () => {
      const { service, falso } = armar([]);
      await expect(
        service.crear(uuid(999), { nombre: 'Extintor' }, DIEGO),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('un rechazo de los candados de la tabla (23514) es 400 COMPONENTE_INVALIDO, no 500', async () => {
      const { service, falso } = armar([]);
      falso.fallar(T, (ops) => tieneOp(ops, 'insert'), {
        code: '23514',
        message:
          'new row for relation "componente_aeronave" violates check constraint "componente_aeronave_nombre_chk"',
      });
      const err: unknown = await service
        .crear(N990GG, { nombre: 'ab' }, DIEGO)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'COMPONENTE_INVALIDO',
      });
    });
  });

  describe('editar — PATCH components/:cid', () => {
    const BASE = comp(11, {
      nombre: 'Batería ELT',
      categoria: 'Emergencia',
      numero_serie: 'SN-1',
      limite_horas: 500,
      limite_meses: 24,
      notas: 'nota vieja',
    });

    it('lo que no viaja no se toca; un null EXPLÍCITO limpia el opcional', async () => {
      const { service, falso } = armar([BASE]);
      const res = await service.editar(
        BASE.id as string,
        {
          nombre: ' Batería del ELT ',
          categoria: null,
          limite_horas: null,
          notas: '   ',
          aviso_dias: 60,
        },
        LUIS,
      );
      const patch = falso.cuerpo(T, 'update');
      expect(Object.keys(patch).sort()).toEqual(
        [
          'aviso_dias',
          'categoria',
          'limite_horas',
          'nombre',
          'notas',
          'updated_at',
          'updated_by',
        ].sort(),
      );
      expect(patch).toMatchObject({
        nombre: 'Batería del ELT',
        categoria: null,
        limite_horas: null,
        notas: null,
        aviso_dias: 60,
        updated_by: LUIS,
        updated_at: AHORA.toISOString(),
      });
      expect(res).toMatchObject({
        nombre: 'Batería del ELT',
        categoria: null,
        numero_serie: 'SN-1', // intacto
        limite_horas: null,
        limite_meses: 24, // intacto
        notas: null,
        aviso_dias: 60,
        estado: 'INSTALADO',
        actualizado_por_nombre: 'Luis',
      });
      // Ya sin límite de horas, manda la fecha (instalación + 24 meses).
      expect(res.vida).toMatchObject({ por: 'FECHA', vence_el: '2028-09-01' });
    });

    it('sin campos ⇒ ni un UPDATE: devuelve la fila tal cual', async () => {
      const { service, falso } = armar([BASE]);
      const res = await service.editar(BASE.id as string, {}, LUIS);
      expect(falso.conOp(T, 'update')).toHaveLength(0);
      expect(res.nombre).toBe('Batería ELT');
      expect(res.actualizado_por_nombre).toBe('Diego Ramírez');
    });

    it('no existe o está eliminado ⇒ 404 COMPONENTE_NO_ENCONTRADO', async () => {
      const { service, falso } = armar([
        comp(12, { eliminado_at: '2026-11-01T00:00:00Z' }),
      ]);
      for (const id of [uuid(12), uuid(404)]) {
        const err: unknown = await service
          .editar(id, { nombre: 'Otro' }, LUIS)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundException);
        expect((err as NotFoundException).getResponse()).toMatchObject({
          error: 'COMPONENTE_NO_ENCONTRADO',
        });
      }
      expect(falso.conOp(T, 'update')).toHaveLength(0);
    });
  });

  describe('retirar — POST components/:cid/retirar', () => {
    const LLANTA = comp(11, {
      nombre: 'Llanta de nariz',
      limite_horas: 300,
      horas_previas: 20,
    });

    it('pasa a RETIRADO con fecha, Hobbs y motivo; la vida queda congelada', async () => {
      const { service, falso } = armar([LLANTA]);
      const res = await service.retirar(
        LLANTA.id as string,
        { fecha: '2026-11-17', horas_aeronave: 5590, motivo: ' Ponchadura ' },
        LUIS,
      );
      expect(falso.cuerpo(T, 'update')).toMatchObject({
        estado: 'RETIRADO',
        fecha_retiro: '2026-11-17',
        horas_aeronave_retiro: 5590,
        motivo_retiro: 'Ponchadura',
        updated_by: LUIS,
      });
      expect(res).toMatchObject({
        estado: 'RETIRADO',
        fecha_retiro: '2026-11-17',
        horas_aeronave_retiro: 5590,
        motivo_retiro: 'Ponchadura',
      });
      expect(res.vida).toMatchObject({
        horas_en_servicio: 110, // 20 + (5590 − 5500)
        horas_restantes: null,
        estado: 'SIN_LIMITE',
      });
      // No se crea ningún sustituto.
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('sin Hobbs en el cuerpo ⇒ el Hobbs ACTUAL del avión (el de la ficha)', async () => {
      const { service, falso, currentHobbs } = armar([LLANTA]);
      await service.retirar(LLANTA.id as string, { fecha: '2026-11-17' }, LUIS);
      expect(falso.cuerpo(T, 'update')).toMatchObject({
        horas_aeronave_retiro: HOBBS,
        motivo_retiro: null,
      });
      expect(currentHobbs).toHaveBeenCalledWith(N990GG);
    });

    it('avión sin lecturas y sin Hobbs en el cuerpo ⇒ se retira con Hobbs null (no con 0)', async () => {
      const { service, falso, currentHobbs } = armar([LLANTA]);
      currentHobbs.mockResolvedValue(0);
      const res = await service.retirar(
        LLANTA.id as string,
        { fecha: '2026-11-17' },
        LUIS,
      );
      expect(falso.cuerpo(T, 'update').horas_aeronave_retiro).toBeNull();
      expect(res.vida.horas_en_servicio).toBeNull();
    });

    it('ya retirado ⇒ 409 COMPONENTE_YA_RETIRADO y nada escrito', async () => {
      const { service, falso } = armar([
        comp(12, { estado: 'RETIRADO', fecha_retiro: '2026-10-01' }),
      ]);
      const err: unknown = await service
        .retirar(uuid(12), { fecha: '2026-11-17' }, LUIS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'COMPONENTE_YA_RETIRADO',
      });
      expect(falso.conOp(T, 'update')).toHaveLength(0);
    });

    it('fecha anterior a la instalación ⇒ 400 y nada escrito', async () => {
      const { service, falso } = armar([LLANTA]);
      const err: unknown = await service
        .retirar(LLANTA.id as string, { fecha: '2026-08-31' }, LUIS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        error: 'FECHA_ANTERIOR_A_INSTALACION',
      });
      expect(falso.conOp(T, 'update')).toHaveLength(0);
    });
  });

  describe('reemplazar — POST components/:cid/reemplazar', () => {
    const VIEJO = comp(11, {
      nombre: 'Llanta principal izquierda',
      categoria: 'Tren de aterrizaje',
      posicion: 'Principal izquierda',
      numero_parte: 'PN-VIEJO',
      numero_serie: 'SN-VIEJO',
      fabricante: 'Goodyear',
      horas_previas: 5,
      limite_horas: 500,
      limite_meses: 24,
      fecha_vencimiento: '2027-01-01',
      aviso_horas: 15,
      aviso_dias: 45,
      notas: 'nota de la vieja',
    });

    it('el viejo queda RETIRADO y entra el nuevo: hereda nombre/categoría/posición/avisos/límites; NO la fecha exacta ni los datos de la pieza', async () => {
      const { service, falso } = armar([VIEJO]);
      const res = await service.reemplazar(
        VIEJO.id as string,
        { fecha: '2026-11-17', motivo: 'Desgaste' },
        LUIS,
      );
      // Orden: primero el alta del nuevo, luego el retiro del viejo.
      const ordenEscrituras = falso.consultas
        .filter(
          (c) =>
            c.tabla === T &&
            (tieneOp(c.ops, 'insert') || tieneOp(c.ops, 'update')),
        )
        .map((c) => (tieneOp(c.ops, 'insert') ? 'insert' : 'update'));
      expect(ordenEscrituras).toEqual(['insert', 'update']);

      expect(falso.cuerpo(T, 'insert')).toMatchObject({
        aeronave_id: N990GG,
        nombre: 'Llanta principal izquierda',
        categoria: 'Tren de aterrizaje',
        posicion: 'Principal izquierda',
        numero_parte: null,
        numero_serie: null,
        fabricante: null,
        notas: null,
        fecha_instalacion: '2026-11-17',
        horas_aeronave_instalacion: HOBBS, // sin Hobbs en el cuerpo ⇒ el actual
        horas_previas: 0,
        limite_horas: 500,
        limite_meses: 24,
        fecha_vencimiento: null, // la del viejo NO se hereda
        aviso_horas: 15,
        aviso_dias: 45,
        estado: 'INSTALADO',
        reemplaza_a_id: VIEJO.id,
        created_by: LUIS,
        updated_by: LUIS,
      });
      expect(falso.cuerpo(T, 'update')).toMatchObject({
        estado: 'RETIRADO',
        fecha_retiro: '2026-11-17',
        horas_aeronave_retiro: HOBBS,
        motivo_retiro: 'Desgaste',
      });

      expect(res.retirado).toMatchObject({
        id: VIEJO.id,
        estado: 'RETIRADO',
        reemplazado_por_id: res.nuevo.id,
        numero_serie: 'SN-VIEJO',
      });
      expect(res.retirado.vida).toMatchObject({
        horas_en_servicio: 104.4, // 5 + (5599.4 − 5500)
        estado: 'SIN_LIMITE',
      });
      expect(res.nuevo).toMatchObject({
        estado: 'INSTALADO',
        reemplaza_a_id: VIEJO.id,
        reemplazado_por_id: null,
        actualizado_por_nombre: 'Luis',
      });
      expect(res.nuevo.vida).toMatchObject({
        horas_en_servicio: 0,
        horas_restantes: 500,
        vence_el: '2028-11-17',
        estado: 'VIGENTE',
      });
      // En la tabla: uno instalado y uno retirado.
      expect(
        falso
          .de(T)
          .map((f) => f.estado)
          .sort(),
      ).toEqual(['INSTALADO', 'RETIRADO']);
    });

    it('`nuevo` cambia lo que trae: datos de la pieza, horas previas, límites (null = sin límite) y fecha exacta', async () => {
      const { service, falso } = armar([VIEJO]);
      await service.reemplazar(
        VIEJO.id as string,
        {
          fecha: '2026-11-17',
          horas_aeronave: 5598,
          nuevo: {
            numero_parte: ' PN-NUEVO ',
            numero_serie: 'SN-NUEVO',
            fabricante: 'Michelin',
            horas_previas: 30,
            limite_horas: 600,
            limite_meses: null,
            fecha_vencimiento: '2029-06-30',
            notas: 'usada, de otro avión',
          },
        },
        LUIS,
      );
      expect(falso.cuerpo(T, 'insert')).toMatchObject({
        numero_parte: 'PN-NUEVO',
        numero_serie: 'SN-NUEVO',
        fabricante: 'Michelin',
        horas_previas: 30,
        limite_horas: 600,
        limite_meses: null,
        fecha_vencimiento: '2029-06-30',
        notas: 'usada, de otro avión',
        horas_aeronave_instalacion: 5598,
      });
      expect(falso.cuerpo(T, 'update')).toMatchObject({
        horas_aeronave_retiro: 5598,
        motivo_retiro: null,
      });
    });

    // PRECISIÓN DEL CONTRATO (panel, 17-nov-2026): en `nuevo`, `limite_horas`
    // y `limite_meses` viajan SIEMPRE, como número o como null explícito.
    it.each<
      [
        string,
        NuevoComponenteReemplazoDto | undefined,
        { limite_horas: number | null; limite_meses: number | null },
      ]
    >([
      ['sin `nuevo`', undefined, { limite_horas: 500, limite_meses: 24 }],
      ['`nuevo` vacío', {}, { limite_horas: 500, limite_meses: 24 }],
      [
        'los dos en null',
        { limite_horas: null, limite_meses: null },
        { limite_horas: null, limite_meses: null },
      ],
      [
        'horas en null, meses ausente',
        { limite_horas: null },
        { limite_horas: null, limite_meses: 24 },
      ],
      [
        'meses en null, horas ausente',
        { limite_meses: null },
        { limite_horas: 500, limite_meses: null },
      ],
      [
        'horas con número, meses en null',
        { limite_horas: 300, limite_meses: null },
        { limite_horas: 300, limite_meses: null },
      ],
      [
        'horas en null, meses con número',
        { limite_horas: null, limite_meses: 12 },
        { limite_horas: null, limite_meses: 12 },
      ],
    ])(
      'límites de `nuevo` — %s: null EXPLÍCITO = la pieza nueva NO tiene ese límite; AUSENTE = hereda el del que sale',
      async (_caso, nuevo, esperado) => {
        // El que sale (VIEJO) tiene 500 h y 24 meses.
        const { service, falso } = armar([VIEJO]);
        const res = await service.reemplazar(
          VIEJO.id as string,
          { fecha: '2026-11-17', ...(nuevo === undefined ? {} : { nuevo }) },
          LUIS,
        );
        const guardado = falso.cuerpo(T, 'insert');
        expect(guardado.limite_horas).toBe(esperado.limite_horas);
        expect(guardado.limite_meses).toBe(esperado.limite_meses);
        expect(res.nuevo.limite_horas).toBe(esperado.limite_horas);
        expect(res.nuevo.limite_meses).toBe(esperado.limite_meses);
        // El que sale conserva los suyos.
        expect(res.retirado).toMatchObject({
          limite_horas: 500,
          limite_meses: 24,
        });
      },
    );

    it('con los dos límites en null la pieza nueva queda «a condición» aunque la que sale tuviera límites', async () => {
      const { service } = armar([VIEJO]);
      const res = await service.reemplazar(
        VIEJO.id as string,
        {
          fecha: '2026-11-17',
          nuevo: { limite_horas: null, limite_meses: null },
        },
        LUIS,
      );
      expect(res.nuevo.vida).toMatchObject({
        estado: 'SIN_LIMITE',
        por: null,
        horas_restantes: null,
        vence_el: null,
      });
    });

    it.each<[string, NuevoComponenteReemplazoDto | undefined]>([
      ['sin `nuevo`', undefined],
      ['`nuevo` vacío (campos ausentes)', {}],
      [
        'null explícito',
        {
          numero_parte: null,
          numero_serie: null,
          fabricante: null,
          notas: null,
          fecha_vencimiento: null,
        },
      ],
    ])(
      'los demás opcionales de `nuevo` — %s ⇒ vacíos: P/N, S/N, fabricante, notas y fecha exacta son de la PIEZA, no se heredan',
      async (_caso, nuevo) => {
        // El que sale trae PN-VIEJO, SN-VIEJO, Goodyear, notas y fecha exacta.
        const { service, falso } = armar([VIEJO]);
        const res = await service.reemplazar(
          VIEJO.id as string,
          { fecha: '2026-11-17', ...(nuevo === undefined ? {} : { nuevo }) },
          LUIS,
        );
        const vacios = {
          numero_parte: null,
          numero_serie: null,
          fabricante: null,
          notas: null,
          fecha_vencimiento: null,
        };
        expect(falso.cuerpo(T, 'insert')).toMatchObject(vacios);
        expect(res.nuevo).toMatchObject(vacios);
        // Las horas previas por omisión son 0 (pieza nueva).
        expect(falso.cuerpo(T, 'insert').horas_previas).toBe(0);
      },
    );

    it('ya retirado ⇒ 409 COMPONENTE_YA_RETIRADO sin escribir nada', async () => {
      const { service, falso } = armar([
        comp(12, { estado: 'RETIRADO', fecha_retiro: '2026-10-01' }),
      ]);
      const err: unknown = await service
        .reemplazar(uuid(12), { fecha: '2026-11-17' }, LUIS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'COMPONENTE_YA_RETIRADO',
      });
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
      expect(falso.conOp(T, 'update')).toHaveLength(0);
    });

    it('fecha anterior a la instalación ⇒ 400 sin escribir nada', async () => {
      const { service, falso } = armar([VIEJO]);
      await expect(
        service.reemplazar(VIEJO.id as string, { fecha: '2026-08-01' }, LUIS),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(falso.conOp(T, 'insert')).toHaveLength(0);
    });

    it('CAMBIO A MEDIAS (falla el retiro del viejo): el nuevo se da de baja y se responde el error — nunca dos instalados', async () => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      const { service, falso } = armar([VIEJO]);
      falso.fallar(
        T,
        (ops) =>
          ops.some(
            (o) =>
              o.m === 'update' && (o.args[0] as Fila).estado === 'RETIRADO',
          ),
        { message: 'connection reset' },
      );
      await expect(
        service.reemplazar(VIEJO.id as string, { fecha: '2026-11-17' }, LUIS),
      ).rejects.toThrow('connection reset');
      const filas = falso.de(T);
      expect(filas).toHaveLength(2);
      const viejo = filas.find((f) => f.id === VIEJO.id) as Fila;
      const nuevo = filas.find((f) => f.id !== VIEJO.id) as Fila;
      expect(viejo.estado).toBe('INSTALADO'); // el viejo sigue como estaba
      expect(nuevo.eliminado_at).toBe(AHORA.toISOString());
      expect(nuevo.eliminado_por).toBe(LUIS);
      // La lista del avión vuelve a mostrar UN solo instalado: el viejo.
      const lista = await service.listar(N990GG);
      expect(lista.componentes.map((c) => c.id)).toEqual([VIEJO.id]);
      expect(lista.retirados).toEqual([]);
      error.mockRestore();
    });

    it('CARRERA (otro lo retiró entre la lectura y el retiro): el nuevo se da de baja y responde 409', async () => {
      const { service, falso } = armar([VIEJO]);
      // Justo cuando entra el alta del nuevo, «otra persona» retira el viejo.
      falso.antesDeCadaConsulta((c) => {
        if (c.tabla === T && tieneOp(c.ops, 'insert')) {
          const fila = falso.de(T).find((f) => f.id === VIEJO.id) as Fila;
          fila.estado = 'RETIRADO';
          fila.fecha_retiro = '2026-11-17';
        }
      });
      const err: unknown = await service
        .reemplazar(VIEJO.id as string, { fecha: '2026-11-17' }, LUIS)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        error: 'COMPONENTE_YA_RETIRADO',
      });
      const nuevo = falso.de(T).find((f) => f.id !== VIEJO.id) as Fila;
      expect(nuevo.eliminado_at).not.toBeNull();
      // Ni un instalado de más.
      expect(
        falso
          .de(T)
          .filter((f) => f.estado === 'INSTALADO' && f.eliminado_at == null),
      ).toHaveLength(0);
    });
  });

  describe('eliminar — DELETE components/:cid', () => {
    it('baja con sello: la fila se conserva y deja de listarse', async () => {
      const { service, falso } = armar([comp(11, { nombre: 'Capturado mal' })]);
      await expect(service.eliminar(uuid(11), DIEGO)).resolves.toEqual({
        ok: true,
      });
      expect(falso.de(T)).toHaveLength(1);
      expect(falso.de(T)[0]).toMatchObject({
        eliminado_at: AHORA.toISOString(),
        eliminado_por: DIEGO,
      });
      // Ningún DELETE de verdad.
      expect(falso.conOp(T, 'delete')).toHaveLength(0);
      expect((await service.listar(N990GG)).componentes).toEqual([]);
    });

    it('la segunda vez (o un id que no existe) ⇒ 404', async () => {
      const { service } = armar([comp(11, {})]);
      await service.eliminar(uuid(11), DIEGO);
      await expect(service.eliminar(uuid(11), DIEGO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.eliminar(uuid(404), DIEGO)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('migración 20261117000001 sin aplicar', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    it('listar ⇒ disponible:false con listas vacías (no revienta ni lee el Hobbs)', async () => {
      const { service, currentHobbs } = armar([], { ausentes: [T] });
      await expect(service.listar(N990GG)).resolves.toEqual({
        disponible: false,
        horas_aeronave: null,
        hoy: '2026-11-17',
        componentes: [],
        retirados: [],
      });
      expect(currentHobbs).not.toHaveBeenCalled();
    });

    it('toda escritura ⇒ 503 MIGRACION_PENDIENTE en es-MX', async () => {
      const { service } = armar([], { ausentes: [T] });
      const intentos: Array<() => Promise<unknown>> = [
        () => service.crear(N990GG, { nombre: 'Extintor' }, DIEGO),
        () => service.editar(uuid(11), { nombre: 'Otro' }, DIEGO),
        () => service.retirar(uuid(11), { fecha: '2026-11-17' }, DIEGO),
        () => service.reemplazar(uuid(11), { fecha: '2026-11-17' }, DIEGO),
        () => service.eliminar(uuid(11), DIEGO),
      ];
      for (const intento of intentos) {
        const err: unknown = await intento().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const cuerpo = (err as ServiceUnavailableException).getResponse();
        expect(cuerpo).toMatchObject({
          error: 'MIGRACION_PENDIENTE',
          details: { migracion: '20261117000001' },
        });
        expect((cuerpo as { message: string }).message).toMatch(
          /todavía no están disponibles/,
        );
      }
    });
  });
});

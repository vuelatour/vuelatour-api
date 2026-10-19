import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import {
  CambioFechaGastoDto,
  CategoriaGasto,
  CreateGastoDto,
  CreateTarifaAerodromoDto,
  DeleteGastoQuery,
  GenerarPistasDto,
  ListGastosQuery,
  PhotoUrlsDto,
  PistasPendientesQuery,
  SugerirVueloQuery,
  UpdateGastoDto,
  UpdateTarifaAerodromoDto,
  ListOtrosGastosQuery,
  PutRepartoDto,
  RepartoIgualesDto,
  RepartoMasivoDto,
} from './dto/expenses.dto';
import {
  CargaMasivaCombustibleDto,
  PreviewCargaCombustibleDto,
} from './dto/combustible-masivo.dto';
import { CombustibleMasivoService } from './combustible-masivo.service';
import { ExpensesService } from './expenses.service';
import {
  puedeVerDetalleBanco,
  ROLES_CONCILIACION,
} from '../conciliacion/roles-conciliacion';
import { MENSAJE_CONCILIAR_SOLO_ADMIN_FACTURACION } from '../conciliacion/cargos-a-gasto.util';
import { esPatchSoloMarcarPagado } from './por-pagar.util';

@ApiTags('Expenses')
@ApiBearerAuth()
@Controller({ path: 'expenses', version: '1' })
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly combustibleMasivo: CombustibleMasivoService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List gastos (with filters). Pilotos see only own captures. Los gastos de medio BANCARIO traen los aditivos monto_vinculado / faltante / parcial (pagos parciales, 14-sep-2026) y los NO bancarios (salvo bodega) que tengan algún cargo ligado (efectivo con justificación) traen los aditivos monto_vinculado / faltante / parcial (13-oct-2026, invariante 71). Orden con desempate por id. Con la migración 20261019000001 cada gasto trae `por_pagar` y `estado_pago` (PAGADO | POR_PAGAR | VENCIDO) y `?por_pagar=1` filtra los no pagados (invariante 93).',
  })
  async list(@Query() q: ListGastosQuery, @CurrentUser() c: AuthenticatedUser) {
    const filters = { ...q };
    // Pilotos y mecánicos solo ven sus propias capturas: se fuerza SIEMPRE su
    // propio id (con ?usuario_captura_id=<otro> listaban gastos ajenos). El
    // mecánico, además, solo combustible (GAS) — no ve el resto de gastos.
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      filters.usuario_captura_id = c.userId;
    }
    if (c.rol === Rol.MECANICO) {
      filters.categoria = CategoriaGasto.GAS;
    }
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      // El sello de confirmación es del PANEL (28-ago): a la app ni viaja.
      const res = await this.expenses.list(filters);
      for (const g of (res as { data?: Array<Record<string, unknown>> }).data ??
        []) {
        delete g.verificado_por;
        delete g.verificado_at;
        delete g.verificador;
      }
      return res;
    }
    return this.expenses.list(filters);
  }

  @Get('sugerir-vuelo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.PILOTO, Rol.MECANICO)
  @ApiOperation({
    summary:
      'Sugiere el vuelo al que corresponde una carga de combustible (aeronave + momento de la carga). En ruta → ese vuelo; si no → siguiente salida.',
  })
  sugerirVuelo(@Query() q: SugerirVueloQuery) {
    return this.expenses.sugerirVuelo(q.aeronave_id, q.fecha_hora);
  }

  @Post('sugerir-asignaciones')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Barrido de la bandeja: sugiere vuelo/avión para TODOS los gastos pendientes (máx 15). Devuelve gasto→sugerencia; la oficina aplica en lote.',
  })
  sugerirAsignaciones() {
    return this.expenses.sugerirAsignaciones();
  }

  @Get(':id/sugerir-asignacion')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Sugiere a qué vuelo/avión pertenece un gasto de la bandeja: vuelos del capturista a ±3 días (regla si hay uno el mismo día; IA si hay varios). Sin candidatos → sin match (asignación manual).',
  })
  sugerirAsignacion(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.sugerirAsignacion(id);
  }

  @Get('export')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Gastos por avión/categoría en Excel (respeta filtros). Lectura paginada de 1000 en 1000 (antes se cortaba en 1000 filas; tope 20,000 con aviso). ADMIN/FACTURACION: + «Factura», «Cargo del banco», «Estado de cuenta» al final y la pestaña «Cargos del banco» (conciliación al revés, invariante 71); COORDINADOR/ANALISTA: el libro de siempre.',
  })
  async export(
    @Query() q: ListGastosQuery,
    @CurrentUser() c: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const buffer = await this.expenses.listXlsx(q, {
      detalleBanco: puedeVerDetalleBanco(c.rol),
    });
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="gastos.xlsx"',
    });
  }

  @Post()
  @Roles(
    Rol.ADMIN,
    Rol.COORDINADOR,
    Rol.FACTURACION,
    Rol.PILOTO,
    Rol.MECANICO,
    Rol.VISITANTE,
  )
  @ApiOperation({
    summary:
      'Capture a gasto. Pilotos/mecánicos lo usan desde la app móvil. El mecánico solo carga combustible. `tua_incluida` es de oficina (se ignora a piloto/mecánico/visitante). Gastos por pagar (invariante 93): una REFACCION con `inventario` y fecha futura ⇒ 400 INVENTARIO_FECHA_FUTURA sin crear nada (con la migración 20261019000001).',
  })
  create(@Body() dto: CreateGastoDto, @CurrentUser() c: AuthenticatedUser) {
    // El semáforo de facturación es seguimiento de OFICINA: piloto/mecánico
    // no pueden fijarlo (si pudieran, un gasto se afirmaría "facturado" sin
    // que oficina viera factura alguna — candado multicapa).
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      delete dto.estatus_facturacion;
      // «TUA incluida en este gasto» (13-oct-2026, invariante 66): campo de
      // OFICINA — se ignora, jamás un 400 por un campo que la app no ve.
      delete dto.tua_incluida;
      this.assertFotoPropia(dto.foto_url, c.authId);
    }
    // VARIOS CARGOS → UN GASTO (14-oct-2026, invariante 76): vincular con el
    // banco es de quien concilia (ADMIN, FACTURACION), antes del servicio.
    // `null` = ausente, el MISMO criterio de `create()` (revisión del
    // 14-oct-2026): un formulario que manda la llave en null en un alta
    // normal no le da 403 a quien no concilia.
    if (
      dto.conciliar_con_movimientos != null &&
      !ROLES_CONCILIACION.includes(c.rol)
    ) {
      throw new ForbiddenException({
        message: MENSAJE_CONCILIAR_SOLO_ADMIN_FACTURACION,
        error: 'CONCILIAR_SOLO_ADMIN_FACTURACION',
      });
    }
    return this.expenses.create(dto, c.userId, c.rol);
  }

  /**
   * La foto del gasto de un piloto/mecánico debe ser una SUBIDA PROPIA: la
   * app sube a gasto-fotos con path `<AUTH uid>/<yyyy-MM>/<uuid>.ext`. Sin
   * este candado, un PATCH podía apuntar el gasto a la foto de OTRO usuario
   * (la política de lectura del bucket no filtra por dueño) o a un string
   * basura que el panel intentaría firmar sin éxito.
   *
   * OJO (bug 18-ago): el prefijo del path es el `supabase_auth_id`
   * (c.authId, el sub del JWT con el que la app sube al Storage) — NUNCA
   * `usuario.id` (c.userId): son ids distintos y comparar contra userId
   * bloqueó TODAS las capturas con foto de pilotos.
   */
  private assertFotoPropia(fotoUrl: string | undefined, authId: string) {
    if (fotoUrl && !fotoUrl.startsWith(`${authId}/`)) {
      throw new BadRequestException(
        'La foto del comprobante debe ser una subida tuya.',
      );
    }
  }

  @Post('photo-urls')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Firma URLs de fotos de recibos (bucket privado) para el panel admin.',
  })
  photoUrls(@Body() dto: PhotoUrlsDto) {
    return this.expenses.signPhotos(dto.paths);
  }

  // ===== Gastos de pista (cuotas de aeródromo) — rutas literales antes de :id =====

  @Get('otros-gastos')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Gastos GENERALES del periodo (sin vuelo: OTRO/FIJO/INDIRECTO/GASOLINA/VISITA; la NÓMINA vive en su módulo desde el 16-oct-2026) con su reparto entre aviones y el resumen del mes (asignado vs gasto de la empresa VuelaTour).',
  })
  otrosGastos(@Query() q: ListOtrosGastosQuery) {
    return this.expenses.listOtrosGastos(q.desde, q.hasta);
  }

  @Get('pistas/pendientes')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Aterrizajes del periodo (destino ≠ CUN) sin gasto de pista, con monto sugerido del tarifario. La oficina revisa y confirma.',
  })
  pistasPendientes(@Query() q: PistasPendientesQuery) {
    return this.expenses.pistasPendientes(q.desde, q.hasta);
  }

  @Post('pistas/generar')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Crea los gastos de pista confirmados (origen SISTEMA, un gasto por aterrizaje, SIN_COMPROBANTE hasta amarrar la factura).',
  })
  generarPistas(
    @Body() dto: GenerarPistasDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.generarPistas(dto, c.userId);
  }

  @Get('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Tarifario de cuotas de aterrizaje por aeródromo/modelo.',
  })
  listTarifas() {
    return this.expenses.listTarifasAerodromo();
  }

  @Post('tarifas-aerodromo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Agrega una tarifa de aeródromo.' })
  createTarifa(
    @Body() dto: CreateTarifaAerodromoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.createTarifaAerodromo(dto, c.userId);
  }

  @Patch('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({ summary: 'Actualiza una tarifa de aeródromo.' })
  updateTarifa(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTarifaAerodromoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.updateTarifaAerodromo(id, dto, c.userId);
  }

  @Delete('tarifas-aerodromo/:id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Elimina una tarifa de aeródromo.' })
  removeTarifa(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.removeTarifaAerodromo(id);
  }

  // ===== Carga masiva de combustibles (Excel) — rutas literales antes de :id =====
  // Roles = los de oficina que capturan gastos (el @Roles del create SIN
  // piloto/mecánico: ellos cargan desde la app, no por Excel).

  @Get('combustibles/plantilla.xlsx')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Plantilla Excel para la carga masiva de combustibles, con los catálogos reales (matrículas, proveedores, medios de pago) como listas.',
  })
  async plantillaCombustibles(): Promise<StreamableFile> {
    const buffer = await this.combustibleMasivo.plantillaXlsx();
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment; filename="plantilla-combustibles.xlsx"',
    });
  }

  @Post('combustibles/carga-masiva/preview')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Valida el Excel llenado SIN crear nada: errores y advertencias por fila + datos normalizados (aeronave, vuelo, proveedor resueltos).',
  })
  previewCargaCombustibles(@Body() dto: PreviewCargaCombustibleDto) {
    return this.combustibleMasivo.preview(dto);
  }

  @Post('combustibles/carga-masiva')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Crea los gastos GAS de las filas validadas. Re-valida TODO en servidor; procesa todas las filas y reporta creados vs errores por fila.',
  })
  cargaMasivaCombustibles(
    @Body() dto: CargaMasivaCombustibleDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.combustibleMasivo.cargaMasiva(dto, c.userId, c.rol);
  }

  // ===== Reparto masivo — ruta literal antes de :id =====

  @Post('reparto-masivo')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aplica el MISMO reparto porcentual entre aviones a varios gastos generales (reemplaza el reparto vigente de cada uno). Procesa todos y reporta éxitos vs errores por gasto.',
  })
  repartoMasivo(
    @Body() dto: RepartoMasivoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.putRepartoMasivo(dto, c.userId);
  }

  // ===== Nómina: reparto en PARTES IGUALES — ruta literal antes de :id =====
  // (16-oct-2026, API 0.0.90, invariante 91). Mismos roles que el reparto
  // masivo.

  @Post('reparto-iguales')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reparte cada pago en PARTES IGUALES (centavos enteros, Σ == monto, el residuo rota entre aviones a lo largo del lote) entre los aviones ACTIVOS elegidos; aeronave_ids [] quita el reparto; simular: true no escribe. Errores por pago (GASTO_NO_EXISTE, CATEGORIA_NO_REPARTIBLE, GASTO_CON_VUELO, MONTO_MUY_CHICO, MES_CERRADO, ERROR) sin tumbar el lote; 400 AERONAVE_INACTIVA antes de tocar nada.',
  })
  repartoIguales(
    @Body() dto: RepartoIgualesDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.putRepartoIguales(dto, c.userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get gasto by id. Piloto/mecánico solo ven sus propias capturas.',
  })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    const gasto = await this.expenses.findById(id);
    if (
      (c.rol === Rol.PILOTO ||
        c.rol === Rol.MECANICO ||
        c.rol === Rol.VISITANTE) &&
      (gasto as { usuario_captura_id: string | null }).usuario_captura_id !==
        c.userId
    ) {
      throw new ForbiddenException('No tienes acceso a este gasto');
    }
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      const g = gasto as Record<string, unknown>;
      delete g.verificado_por;
      delete g.verificado_at;
      delete g.verificador;
      return gasto;
    }
    // ADITIVO (16-oct-2026, invariante 87): las facturas del gasto para
    // «Verificar / editar» (solo oficina; sin la llave si la lectura falla).
    if (
      c.rol === Rol.ADMIN ||
      c.rol === Rol.COORDINADOR ||
      c.rol === Rol.FACTURACION
    ) {
      const extra = await this.expenses.facturasDelGasto(gasto);
      if (extra) return { ...gasto, ...extra };
    }
    return gasto;
  }

  @Post(':id/reanalizar-ia')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reanaliza el comprobante guardado con la IA de visión. SOLO-LECTURA: devuelve la lectura para prellenar el formulario; valor_ia_extraido se guarda junto con el PATCH cuando el humano confirma.',
  })
  async reanalizarIA(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.reanalizarConIA(id, c.userId);
  }

  @Get(':id/reparto')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary: 'Reparto del gasto entre aviones (items + remanente de empresa).',
  })
  getReparto(@Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.getReparto(id);
  }

  @Put(':id/reparto')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.FACTURACION)
  @ApiOperation({
    summary:
      'Reemplaza el reparto del gasto entre aviones ([] lo limpia). Solo gastos generales sin vuelo; Σ <= monto; el remanente es gasto de la empresa VuelaTour.',
  })
  putReparto(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutRepartoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.putReparto(id, dto.items, c.userId);
  }

  @Post(':id/visto-bueno')
  @Roles(Rol.ADMIN, Rol.FACTURACION, Rol.ANALISTA)
  @ApiOperation({
    summary:
      'Da el visto bueno de administración a un gasto prellenado con IA desde la app (marca quién y cuándo; quita la bandera de pendiente).',
  })
  async vistoBueno(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.darVistoBueno(id, c.userId);
  }

  // FECHA DEL PAGO desde Conciliación (14-oct-2026, invariante 74): ruta
  // APARTE del PATCH general (que sigue igual, auto-cruce incluido). Va antes
  // de @Patch(':id'); no choca con @Patch('tarifas-aerodromo/:id') porque su
  // segundo segmento es literal.
  @Patch(':id/fecha')
  @Roles(...ROLES_CONCILIACION)
  @ApiOperation({
    summary:
      'FECHA DEL PAGO desde Conciliación (14-oct-2026, invariante 74): cambia SOLO fecha_gasto (y la hora de la carga al mismo día) de un gasto BANCARIO, SIN auto-cruce. 400 FECHA_GASTO_INVALIDA / FECHA_GASTO_FUTURA / FECHA_GASTO_MUY_ANTIGUA; 404 GASTO_NO_EXISTE; 409 FECHA_GASTO_SOLO_BANCARIOS, FECHA_GASTO_YA_CONCILIADO (ya está cubierto por un cargo del banco), FECHA_GASTO_CAMBIO (fecha_anterior ≠ la vigente), FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO (espejo de fechasFuera del balance), FECHA_GASTO_CONFIRMAR (mueve dinero de mes o cambia un mes terminado: repetir con confirmar: true) y CONFLICTO_VERSION. Solo ADMIN y FACTURACION.',
  })
  cambiarFecha(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambioFechaGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    return this.expenses.cambiarFechaGasto(id, dto, c.userId, c.rol);
  }

  @Patch(':id')
  @Roles(
    Rol.ADMIN,
    Rol.COORDINADOR,
    Rol.FACTURACION,
    Rol.PILOTO,
    Rol.MECANICO,
    Rol.VISITANTE,
  )
  @ApiOperation({
    summary:
      'Update gasto. Oficina siempre; piloto/mecánico solo su propio gasto y solo dentro de su semana de captura lunes→domingo + gracia (doc 5.2/5.3, config dias_gracia_gastos_semana). ' +
      'App sin internet (10-sep-2026): `capturado_en` = sello de la corrección (la semana se evalúa contra él), `if_updated_at` = control de versión (409 CONFLICTO_VERSION si alguien lo modificó antes). Rechazos con code: GASTO_AJENO, GASTO_CONCILIADO, GASTO_EN_REPOSICION, GASTO_FUERA_DE_VENTANA. `tua_incluida` es de oficina (se ignora a piloto/mecánico/visitante). ' +
      'Gastos por pagar (19-oct-2026): `{por_pagar: false, fecha_gasto?}` = «Marcar pagado» (fecha del pago ≤ hoy; sin fecha: hoy, o la suya si ya venció); el dueño de campo puede hacerlo fuera de su semana si el PATCH SOLO trae por_pagar, fecha_gasto, if_updated_at y capturado_en (la semana de la fecha del pago se mide con el sello `capturado_en`; un VISITANTE no reescribe la categoría). Reenviar el mismo «marcar pagado» ya aplicado (sin fecha o con la misma) responde la fila sin escribir, aunque el banco ya lo haya conciliado entre los dos envíos. Sin cambio de fecha no pasa por el candado MES_CERRADO. 400 POR_PAGAR_FECHA_FUTURA; 409 GASTO_EN_REPOSICION si la fecha del pago ya la cubrió una reposición de caja chica; 409 GASTO_CONCILIADO al mover a futuro la fecha de un gasto conciliado; 503 POR_PAGAR_NO_DISPONIBLE sin la migración.',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGastoDto,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    // GASTOS POR PAGAR (19-oct-2026, invariante 93): ¿el PATCH SOLO marca
    // pagado? (llaves con valor ⊆ por_pagar, fecha_gasto, if_updated_at,
    // capturado_en). Se decide UNA vez, antes de que los bloques por rol
    // toquen el DTO.
    const soloMarcarPagado = esPatchSoloMarcarPagado(dto);
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      // El PATCH mínimo no está acotado a la semana de corrección; `porPagar`
      // (crudo) le dice al candado de reposición si el gasto entra al libro
      // de caja chica (revisión P7).
      await this.expenses.assertOwnEnVentana(id, c.userId, dto.capturado_en, {
        marcarPagado: soloMarcarPagado,
        fechaPago: dto.fecha_gasto ?? null,
        porPagar: dto.por_pagar ?? null,
      });
      // Seguimiento de OFICINA: el capturador de campo no marca facturado.
      delete dto.estatus_facturacion;
      // «TUA incluida en este gasto» (13-oct-2026): campo de OFICINA.
      delete dto.tua_incluida;
      // Ni concilia ni desmarca duplicados (27-ago): un gasto "conciliado"
      // sin movimiento bancario sobreestima la conciliación en silencio.
      delete dto.conciliado;
      delete dto.duplicado_sospechado;
      // La confirmación es de OFICINA (28-ago): un rol de campo no puede
      // sellarse a sí mismo (y su edición LIMPIA el sello en el service).
      delete dto.verificado;
      // Reemplazo de foto (pedido 17-ago): solo con una subida PROPIA.
      this.assertFotoPropia(dto.foto_url, c.authId);
    }
    if (c.rol === Rol.VISITANTE) {
      // El gasto del visitante ES de visita: no se reclasifica ni se liga a
      // vuelo/avión/escala desde su sesión (candado espejo del create). El
      // PATCH mínimo de «marcar pagado» NO lleva categoría (revisión P8):
      // fuera de su semana solo puede marcarlo pagado, jamás revertir la
      // reclasificación que hizo la oficina.
      if (!soloMarcarPagado) dto.categoria = CategoriaGasto.VISITA;
      delete dto.vuelo_id;
      delete dto.aeronave_id;
      delete dto.escala_id;
    }
    return this.expenses.update(id, dto, c.userId, c.rol);
  }

  @Delete(':id')
  @Roles(Rol.ADMIN, Rol.COORDINADOR, Rol.PILOTO, Rol.MECANICO, Rol.VISITANTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete gasto. Oficina siempre; piloto/mecánico solo el suyo dentro de su semana de captura (lunes→domingo + gracia). ' +
      'App sin internet (10-sep-2026): `?capturado_en=` = sello de la baja (la semana se evalúa contra él). 409 con code: GASTO_CONCILIADO, GASTO_DE_COMPRA, GASTO_REPARTIDO, GASTO_EN_REPOSICION; 2.ª llamada = 404 (éxito idempotente para la app).',
  })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: DeleteGastoQuery,
    @CurrentUser() c: AuthenticatedUser,
  ) {
    if (
      c.rol === Rol.PILOTO ||
      c.rol === Rol.MECANICO ||
      c.rol === Rol.VISITANTE
    ) {
      await this.expenses.assertOwnEnVentana(id, c.userId, q.capturado_en);
    }
    return this.expenses.remove(id, c.userId, c.rol, q.capturado_en);
  }
}

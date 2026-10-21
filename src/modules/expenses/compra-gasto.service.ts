import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Rol } from '../../common/types/auth.types';
import { ComprasService } from '../compras/compras.service';
import { ExpensesService } from './expenses.service';
import type { RegistrarGastoCompraDto } from './dto/compra-gasto.dto';
import {
  CODIGO_COMPRA_GASTO,
  MENSAJE_COMPRA_GASTO,
  cuerpoGastoDeCompra,
  resumenGastoRegistrado,
  validarRegistrarGastoCompra,
} from './compra-gasto.util';

/**
 * «REGISTRAR GASTO» DE UNA COMPRA (21-oct-2026, invariante 101). Vive en el
 * módulo de GASTOS (no en Compras) a propósito: el gasto nace por el alta
 * de siempre (`ExpensesService.create`: candados de fecha, medio y cuenta,
 * folio duplicado, mes cerrado, por pagar, auto-cruce con el banco) y
 * `ExpensesModule` ya importa `ComprasModule` — al revés habría un ciclo.
 *
 * Bajo el CANDADO de la compra: un doble clic se serializa y el segundo
 * intento responde 409 `COMPRA_GASTO_YA_REGISTRADO` (el gasto queda ligado
 * en el MISMO INSERT que lo crea: nunca un gasto suelto a medio ligar).
 */
@Injectable()
export class CompraGastoService {
  private readonly logger = new Logger(CompraGastoService.name);

  constructor(
    private readonly expenses: ExpensesService,
    // @Optional: los specs que arman el módulo a mano no lo pasan; sin él,
    // 503 con qué hacer.
    @Optional() private readonly compras?: ComprasService,
  ) {}

  async registrarGasto(
    compraId: string,
    dto: RegistrarGastoCompraDto,
    userId: string,
    rol?: Rol,
  ) {
    const compras = this.compras;
    if (!compras) {
      throw new ServiceUnavailableException({
        message: MENSAJE_COMPRA_GASTO.NO_DISPONIBLE,
        error: CODIGO_COMPRA_GASTO.NO_DISPONIBLE,
      });
    }
    return compras.bajoCandado(compraId, async () => {
      const { compra, lineas, pagos, resumen } =
        await compras.calcularDe(compraId);
      const invalido = validarRegistrarGastoCompra({
        tc: dto.tc_usd_mxn,
        nLineas: lineas.length,
        resumen,
        pagos,
      });
      if (invalido) {
        const cuerpo = {
          message: invalido.message,
          error: invalido.code,
          ...(invalido.details ? { details: invalido.details } : {}),
        };
        throw invalido.status === 409
          ? new ConflictException(cuerpo)
          : new BadRequestException(cuerpo);
      }
      const cuerpo = cuerpoGastoDeCompra({ compra, resumen, dto });
      // El alta de siempre, con la liga a la compra en el mismo INSERT.
      const gasto = (await this.expenses.create(cuerpo, userId, rol, {
        compra: { id: compraId, rol: 'MERCANCIA' },
      })) as Record<string, unknown>;
      // El T.C. que acaban de capturar sirve también para recibir la compra
      // en pesos (si todavía no tenía y sigue ABIERTA).
      const tcCompraFijado = await compras.fijarTcSiFalta(
        compraId,
        Number(dto.tc_usd_mxn),
        userId,
      );
      this.logger.log(
        `compra #${compra.folio}: gasto ${String(gasto.id)} registrado por ${resumen.total_factura} ${compra.moneda} (T.C. ${dto.tc_usd_mxn})${tcCompraFijado ? ', T.C. fijado en la compra' : ''}`,
      );
      const detalle = await compras.getDetail(compraId);
      return {
        ...detalle,
        gasto_registrado: resumenGastoRegistrado(gasto),
        tc_compra_fijado: tcCompraFijado,
      };
    });
  }
}
